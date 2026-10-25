-- READ-ONLY. Does the P&L know this ASIN sold 2 units?
--
-- The P&L takes revenue from financial_events_cache, not sales_orders. The
-- question is therefore what Amazon settles into that table for a multi-unit
-- order -- a per-unit figure, or the whole line.
DO $p$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== does financial_events_cache carry a quantity at all? ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache'
      AND (column_name ILIKE '%quant%' OR column_name ILIKE '%unit%'
        OR column_name IN ('amount','principal','asin','amazon_order_id','event_type'))
  LOOP RAISE NOTICE '   %', COALESCE(r.cols,'(no matching columns)'); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== this order in the P&L source ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND amazon_order_id='113-1305212-7465044';
  RAISE NOTICE '   % rows -- the P&L does not know this order exists yet', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== a SETTLED multi-unit order, to show what Amazon sends ==';
  RAISE NOTICE '   (112-9573168-6115468: 5 units at 24.98 in sales_orders)';
  FOR r IN
    SELECT left(to_jsonb(f)::text, 700) AS j
    FROM public.financial_events_cache f
    WHERE f.user_id=v_uid AND f.amazon_order_id='112-9573168-6115468'
    LIMIT 3
  LOOP
    RAISE NOTICE '   %', r.j;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no financial events for that order either'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the repaired row: is its stored ROI now stale? ==';
  FOR r IN
    SELECT round(total_sale_amount,2) AS revenue, round(total_cost,2) AS cost,
           round(total_fees,2) AS fees, round(roi,1) AS stored_roi,
           round(((total_sale_amount - total_cost - total_fees) / NULLIF(total_cost,0) * 100)::numeric,1) AS roi_should_be
    FROM public.sales_orders WHERE order_id='113-1305212-7465044'
  LOOP
    RAISE NOTICE '   revenue % | cost % | fees % | stored roi % | implied roi %',
      r.revenue, r.cost, r.fees, r.stored_roi, r.roi_should_be;
  END LOOP;
END
$p$;
