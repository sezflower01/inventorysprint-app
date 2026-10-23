-- ITEM 2: re-check for a running sync INSIDE the apply, at execution time.
--
-- The existing check lives in repull_fire, which runs when the request is
-- QUEUED. That is the wrong moment: pg_net has held requests for minutes
-- behind this project's cron fleet (depth has been observed at 22), and a
-- fetch-profit-loss sync can start during that wait. The queue-time check
-- would have passed and the write would then land on top of a live sync,
-- whose own upserts could interleave with the delete and the insert.
--
-- This guard is inside the transaction that does the damage, so it sees the
-- world as it is at the instant of writing. repull_fire's check stays: it
-- fails fast and cheaply, before an 80-second fetch is spent.

CREATE OR REPLACE FUNCTION public.repull_month_adjustments_apply(
  p_user uuid, p_month date, p_rows jsonb, p_min_rows int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_incoming int := COALESCE(jsonb_array_length(p_rows), 0);
  v_existing int; v_backed int; v_deleted int; v_inserted int; v_bad int;
  v_running int;
BEGIN
  -- EXECUTION-TIME SYNC CHECK. First thing, before the backup or the delete.
  SELECT count(*) INTO v_running FROM public.pl_sync_progress
  WHERE user_id = p_user AND status IN ('running','continue');
  IF v_running > 0 THEN
    RAISE EXCEPTION 'REFUSING %: % P&L sync(s) running AT EXECUTION TIME -- a request queued earlier must not land on a sync that started since',
      to_char(v_start,'YYYY-MM'), v_running;
  END IF;

  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) AS r
  WHERE COALESCE(r->>'event_type','') <> 'adjustment';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'REFUSING: % payload rows are not event_type=adjustment', v_bad;
  END IF;

  SELECT count(*) INTO v_existing FROM public.financial_events_cache
  WHERE user_id = p_user AND event_type = 'adjustment'
    AND event_date >= v_start AND event_date < v_end;

  IF v_incoming < v_existing THEN
    RAISE EXCEPTION 'REFUSING: % incoming < % stored adjustments for % -- fetch looks short',
      v_incoming, v_existing, to_char(v_start,'YYYY-MM');
  END IF;
  IF v_incoming < p_min_rows THEN
    RAISE EXCEPTION 'REFUSING: % incoming < caller minimum % for %',
      v_incoming, p_min_rows, to_char(v_start,'YYYY-MM');
  END IF;
  IF v_incoming = 0 AND v_existing > 0 THEN
    RAISE EXCEPTION 'REFUSING: zero incoming would wipe % stored adjustments', v_existing;
  END IF;

  v_backed := public.fec_backup_month(p_user, v_start);

  DELETE FROM public.financial_events_cache
  WHERE user_id = p_user AND event_type = 'adjustment'
    AND event_date >= v_start AND event_date < v_end;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.financial_events_cache (
    user_id, event_type, event_date, amazon_order_id, asin, marketplace, marketplace_id,
    reimbursements, liquidations, warehouse_lost, warehouse_damage,
    reversal_reimbursement, free_replacement_refund_items, compensated_clawback,
    fbm_shipping_label_fee,
    adjustment_type, seller_sku, quantity, posted_at, raw_event, source
  )
  SELECT
    p_user, 'adjustment', (r->>'event_date')::date,
    COALESCE(r->>'amazon_order_id',''), COALESCE(r->>'asin',''),
    COALESCE(r->>'marketplace','UNKNOWN'), r->>'marketplace_id',
    COALESCE((r->>'reimbursements')::numeric,0),
    COALESCE((r->>'liquidations')::numeric,0),
    COALESCE((r->>'warehouse_lost')::numeric,0),
    COALESCE((r->>'warehouse_damage')::numeric,0),
    COALESCE((r->>'reversal_reimbursement')::numeric,0),
    COALESCE((r->>'free_replacement_refund_items')::numeric,0),
    COALESCE((r->>'compensated_clawback')::numeric,0),
    COALESCE((r->>'fbm_shipping_label_fee')::numeric,0),
    r->>'adjustment_type', r->>'seller_sku',
    NULLIF(r->>'quantity','')::int, NULLIF(r->>'posted_at','')::timestamptz,
    r->'raw_event', 'repull_adjustments'
  FROM jsonb_array_elements(p_rows) AS r;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'month', to_char(v_start,'YYYY-MM'),
    'scope', 'event_type=adjustment only; liquidations untouched',
    'syncs_running_at_exec', v_running,
    'window', jsonb_build_array(v_start, v_end),
    'backed_up', v_backed, 'existing', v_existing, 'incoming', v_incoming,
    'deleted', v_deleted, 'inserted', v_inserted
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_month_adjustments_apply(uuid, date, jsonb, int) TO service_role;

-- THE TEST. Plant a running sync row, call the apply, prove it refuses, then
-- roll the whole thing back so nothing is left behind.
DO $p$
DECLARE v_uid uuid; v_err text; v_refused boolean := false; v_rows_before bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT count(*) INTO v_rows_before FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date>='2026-02-01' AND event_date<'2026-03-01';

  RAISE NOTICE '== TEST: apply must refuse while a sync is running ==';
  RAISE NOTICE '   February currently holds % adjustment rows', v_rows_before;

  BEGIN
    -- Everything in this block is rolled back by the RAISE at the end.
    INSERT INTO public.pl_sync_progress (user_id, status, message)
    VALUES (v_uid, 'running', 'TEST sentinel -- rolled back');

    BEGIN
      PERFORM public.repull_month_adjustments_apply(
        v_uid, '2026-02-01',
        jsonb_build_array(jsonb_build_object(
          'event_type','adjustment','event_date','2026-02-01',
          'amazon_order_id','TEST#1','asin','', 'compensated_clawback', -1)),
        0);
      RAISE NOTICE '   >>> FAILED: the apply did NOT refuse';
    EXCEPTION WHEN others THEN
      v_err := SQLERRM;
      IF v_err LIKE '%AT EXECUTION TIME%' THEN
        v_refused := true;
        RAISE NOTICE '   REFUSED as required:';
        RAISE NOTICE '      %', left(v_err, 150);
      ELSE
        RAISE NOTICE '   refused for a DIFFERENT reason: %', left(v_err,150);
      END IF;
    END;

    -- Undo the sentinel and anything the call managed to do.
    RAISE EXCEPTION 'rollback_sentinel';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'rollback_sentinel' THEN RAISE; END IF;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '   execution-time guard proven: %', v_refused;
  FOR v_err IN
    SELECT count(*)::text FROM public.pl_sync_progress
    WHERE user_id=v_uid AND message LIKE 'TEST sentinel%'
  LOOP RAISE NOTICE '   sentinel rows left behind: % (must be 0)', v_err; END LOOP;
  FOR v_err IN
    SELECT count(*)::text FROM public.financial_events_cache
    WHERE user_id=v_uid AND amazon_order_id = 'TEST#1'
  LOOP RAISE NOTICE '   test rows left in the cache: % (must be 0)', v_err; END LOOP;
END
$p$;
