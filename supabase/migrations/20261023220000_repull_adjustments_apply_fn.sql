-- Atomic apply step for the one-month adjustment re-pull.
--
-- A plpgsql function is a single transaction, which is what makes this safe:
-- the DELETE and the INSERT either both happen or neither does. The previous
-- approach deleted from the edge function and then relied on a separate HTTP
-- call to refill -- and when that call stalled, January sat empty for minutes.
-- There is no window here where the month has no adjustment rows.
--
-- It touches ONLY event_type IN ('adjustment','liquidation'): the two types the
-- adjustment writer produces. Shipments, refunds and service fees are never
-- referenced, so they cannot be harmed by a boundary mistake -- which is the
-- other lesson from October, where an inclusive DELETE against an exclusive
-- re-fetch cost 41 shipment and refund rows.
--
-- BOUNDARY. [month_start, month_start + 1 month) on event_date, matching the
-- caller's fetch window exactly. The full last day is included because the end
-- is the first instant of the next month, not the last date of this one --
-- passing '2026-01-31' would silently exclude Jan 31.

CREATE OR REPLACE FUNCTION public.repull_month_adjustments_apply(
  p_user uuid,
  p_month date,
  p_rows jsonb,
  p_min_rows int DEFAULT 0
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
  v_existing int;
  v_backed int;
  v_deleted int;
  v_inserted int;
  v_cols text;
BEGIN
  SELECT count(*) INTO v_existing FROM public.financial_events_cache
  WHERE user_id = p_user AND event_type IN ('adjustment','liquidation')
    AND event_date >= v_start AND event_date < v_end;

  -- GUARD 1: never replace more rows than we were handed. A short fetch --
  -- truncated paging, a rate limit swallowed mid-stream -- would otherwise
  -- delete real adjustments and put back fewer.
  IF v_incoming < v_existing THEN
    RAISE EXCEPTION 'REFUSING: % incoming rows < % stored for % -- fetch looks short',
      v_incoming, v_existing, to_char(v_start,'YYYY-MM');
  END IF;

  -- GUARD 2: the caller's own expectation, passed in from the API item count.
  IF v_incoming < p_min_rows THEN
    RAISE EXCEPTION 'REFUSING: % incoming rows < caller minimum % for %',
      v_incoming, p_min_rows, to_char(v_start,'YYYY-MM');
  END IF;

  -- GUARD 3: a month with stored adjustments must not be replaced by nothing.
  IF v_incoming = 0 AND v_existing > 0 THEN
    RAISE EXCEPTION 'REFUSING: zero incoming rows would wipe % stored adjustments', v_existing;
  END IF;

  -- Back up the whole month first (idempotent; keeps the ORIGINAL snapshot).
  v_backed := public.fec_backup_month(p_user, v_start);

  DELETE FROM public.financial_events_cache
  WHERE user_id = p_user AND event_type IN ('adjustment','liquidation')
    AND event_date >= v_start AND event_date < v_end;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.financial_events_cache (
    user_id, event_type, event_date, amazon_order_id, asin,
    marketplace, marketplace_id,
    sales, refunds, shipping_credits, shipping_credit_refunds,
    gift_wrap_credits, gift_wrap_credit_refunds, promotional_rebates,
    promotional_rebate_refunds, other_income, reimbursements, liquidations,
    referral_fees, fba_fees, variable_closing_fees, fixed_closing_fees,
    fba_inbound_fees, fba_storage_fees, fba_removal_fees, fba_disposal_fees,
    fba_long_term_storage_fees, other_fees, sales_tax_collected,
    marketplace_facilitator_tax, sales_tax_refunds,
    marketplace_facilitator_tax_refunds, fba_customer_return_fees,
    compensated_clawback, hrr_non_apparel, digital_services_fee,
    warehouse_lost, warehouse_damage, reversal_reimbursement,
    free_replacement_refund_items, fba_inbound_convenience_fee,
    liquidations_brokerage_fee, re_commerce_grading_charge,
    shipping_chargeback, shipping_chargeback_refund, restocking_fee,
    fbm_shipping_label_fee,
    adjustment_type, seller_sku, quantity, posted_at, raw_event, source
  )
  SELECT
    p_user,
    r->>'event_type',
    (r->>'event_date')::date,
    COALESCE(r->>'amazon_order_id',''),
    COALESCE(r->>'asin',''),
    COALESCE(r->>'marketplace','UNKNOWN'),
    r->>'marketplace_id',
    COALESCE((r->>'sales')::numeric,0), COALESCE((r->>'refunds')::numeric,0),
    COALESCE((r->>'shipping_credits')::numeric,0), COALESCE((r->>'shipping_credit_refunds')::numeric,0),
    COALESCE((r->>'gift_wrap_credits')::numeric,0), COALESCE((r->>'gift_wrap_credit_refunds')::numeric,0),
    COALESCE((r->>'promotional_rebates')::numeric,0), COALESCE((r->>'promotional_rebate_refunds')::numeric,0),
    COALESCE((r->>'other_income')::numeric,0), COALESCE((r->>'reimbursements')::numeric,0),
    COALESCE((r->>'liquidations')::numeric,0), COALESCE((r->>'referral_fees')::numeric,0),
    COALESCE((r->>'fba_fees')::numeric,0), COALESCE((r->>'variable_closing_fees')::numeric,0),
    COALESCE((r->>'fixed_closing_fees')::numeric,0), COALESCE((r->>'fba_inbound_fees')::numeric,0),
    COALESCE((r->>'fba_storage_fees')::numeric,0), COALESCE((r->>'fba_removal_fees')::numeric,0),
    COALESCE((r->>'fba_disposal_fees')::numeric,0), COALESCE((r->>'fba_long_term_storage_fees')::numeric,0),
    COALESCE((r->>'other_fees')::numeric,0), COALESCE((r->>'sales_tax_collected')::numeric,0),
    COALESCE((r->>'marketplace_facilitator_tax')::numeric,0), COALESCE((r->>'sales_tax_refunds')::numeric,0),
    COALESCE((r->>'marketplace_facilitator_tax_refunds')::numeric,0),
    COALESCE((r->>'fba_customer_return_fees')::numeric,0),
    COALESCE((r->>'compensated_clawback')::numeric,0), COALESCE((r->>'hrr_non_apparel')::numeric,0),
    COALESCE((r->>'digital_services_fee')::numeric,0), COALESCE((r->>'warehouse_lost')::numeric,0),
    COALESCE((r->>'warehouse_damage')::numeric,0), COALESCE((r->>'reversal_reimbursement')::numeric,0),
    COALESCE((r->>'free_replacement_refund_items')::numeric,0),
    COALESCE((r->>'fba_inbound_convenience_fee')::numeric,0),
    COALESCE((r->>'liquidations_brokerage_fee')::numeric,0),
    COALESCE((r->>'re_commerce_grading_charge')::numeric,0),
    COALESCE((r->>'shipping_chargeback')::numeric,0),
    COALESCE((r->>'shipping_chargeback_refund')::numeric,0),
    COALESCE((r->>'restocking_fee')::numeric,0),
    COALESCE((r->>'fbm_shipping_label_fee')::numeric,0),
    r->>'adjustment_type', r->>'seller_sku',
    NULLIF(r->>'quantity','')::int,
    NULLIF(r->>'posted_at','')::timestamptz,
    r->'raw_event',
    'repull_adjustments'
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (user_id, event_type, event_date, amazon_order_id, asin)
  DO UPDATE SET
    -- Same-key duplicates within one payload are SUMMED, mirroring
    -- dedupeCacheEntries in the sync. Overwriting instead would silently drop
    -- the earlier item's money.
    reimbursements = public.financial_events_cache.reimbursements + EXCLUDED.reimbursements,
    liquidations = public.financial_events_cache.liquidations + EXCLUDED.liquidations,
    warehouse_lost = public.financial_events_cache.warehouse_lost + EXCLUDED.warehouse_lost,
    warehouse_damage = public.financial_events_cache.warehouse_damage + EXCLUDED.warehouse_damage,
    reversal_reimbursement = public.financial_events_cache.reversal_reimbursement + EXCLUDED.reversal_reimbursement,
    free_replacement_refund_items = public.financial_events_cache.free_replacement_refund_items + EXCLUDED.free_replacement_refund_items,
    compensated_clawback = public.financial_events_cache.compensated_clawback + EXCLUDED.compensated_clawback,
    fbm_shipping_label_fee = public.financial_events_cache.fbm_shipping_label_fee + EXCLUDED.fbm_shipping_label_fee,
    adjustment_type = COALESCE(public.financial_events_cache.adjustment_type, EXCLUDED.adjustment_type),
    seller_sku = COALESCE(public.financial_events_cache.seller_sku, EXCLUDED.seller_sku),
    quantity = COALESCE(public.financial_events_cache.quantity, EXCLUDED.quantity),
    posted_at = COALESCE(public.financial_events_cache.posted_at, EXCLUDED.posted_at),
    raw_event = COALESCE(public.financial_events_cache.raw_event, EXCLUDED.raw_event);
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'month', to_char(v_start,'YYYY-MM'),
    'window', jsonb_build_array(v_start, v_end),
    'backed_up', v_backed,
    'existing', v_existing,
    'incoming', v_incoming,
    'deleted', v_deleted,
    'inserted', v_inserted
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_month_adjustments_apply(uuid, date, jsonb, int) TO service_role;

-- BOUNDARY TEST, explicit and rolled back. Proves the window includes the full
-- last day of the month and nothing from the next.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== boundary: what does [month, month+1) cover? ==';
  FOR r IN
    SELECT to_char(m,'YYYY-MM') AS month,
           date_trunc('month', m)::date AS win_start,
           (date_trunc('month', m) + interval '1 month')::date AS win_end,
           ((date_trunc('month', m) + interval '1 month')::date - interval '1 day')::date AS last_day_covered
    FROM (VALUES ('2026-01-01'::date), ('2026-02-01'), ('2026-09-01'), ('2026-10-01')) AS v(m)
  LOOP
    RAISE NOTICE '   % | >= % and < % | last day INCLUDED: %',
      r.month, r.win_start, r.win_end, r.last_day_covered;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the trap it avoids ==';
  RAISE NOTICE '   a window of <= ''2026-01-31'' as a TIMESTAMP means 2026-01-31 00:00,';
  RAISE NOTICE '   so everything after midnight on the 31st falls outside it.';
  FOR r IN
    SELECT count(*) AS jan31_rows FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = '2026-01-31'
  LOOP
    RAISE NOTICE '   January 31 currently holds % rows -- all of them would be', r.jan31_rows;
    RAISE NOTICE '   deleted and not replaced by the naive boundary.';
  END LOOP;
END
$p$;
