-- Narrow the apply step to event_type = 'adjustment' ONLY.
--
-- The first dry run refused with HTTP 409 and it was right to. January holds 92
-- adjustment rows AND 62 liquidation rows, and the liquidations come from
-- RemovalShipmentEventList, which this re-pull does not fetch. Scoping the
-- delete to ('adjustment','liquidation') would have removed 62 rows it could
-- never put back -- the same shape of loss as the 41 October shipment rows,
-- caught this time by a guard before the write instead of by a diff after it.
--
-- Liquidations are out of scope by instruction as well as by safety.

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
BEGIN
  -- Refuse a payload containing anything but adjustments, rather than quietly
  -- inserting a row this function would never clean up on a re-run.
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
    'window', jsonb_build_array(v_start, v_end),
    'backed_up', v_backed, 'existing', v_existing, 'incoming', v_incoming,
    'deleted', v_deleted, 'inserted', v_inserted
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_month_adjustments_apply(uuid, date, jsonb, int) TO service_role;

-- ITEM 2's guard test: prove rows of other types are byte-identical across a
-- run. Hashing every non-adjustment row's full content, so a single changed
-- byte anywhere in a shipment, refund, service fee or liquidation shows up.
CREATE OR REPLACE FUNCTION public.fec_other_types_fingerprint(p_user uuid, p_month date)
RETURNS TABLE (event_type text, rows bigint, fingerprint text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT f.event_type, count(*)::bigint,
         md5(string_agg(
           md5((to_jsonb(f) - ARRAY['id','created_at','updated_at','sync_trace_id'])::text),
           '|' ORDER BY f.event_date, f.amazon_order_id, f.asin))
  FROM public.financial_events_cache f
  WHERE f.user_id = p_user
    AND f.event_type <> 'adjustment'
    AND f.event_date >= date_trunc('month', p_month)::date
    AND f.event_date <  (date_trunc('month', p_month) + interval '1 month')::date
  GROUP BY f.event_type;
$fn$;

GRANT EXECUTE ON FUNCTION public.fec_other_types_fingerprint(uuid, date) TO service_role;

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== January fingerprint of NON-adjustment rows (the before baseline) ==';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-01-01') ORDER BY event_type
  LOOP RAISE NOTICE '   % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;
END
$p$;
