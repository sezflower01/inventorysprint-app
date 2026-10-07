-- READ-ONLY PROBE. "When will this be fixed for the P&L?"
--
-- Before promising a date, establish whether the P&L is affected at all. The
-- currency mislabel damaged `sales_orders.estimated_price` -- the figure used
-- for orders that have NOT settled. The P&L is built from
-- financial_events_cache through get_monthly_pl_breakdown /
-- get_pl_live_summary, which is settled money.
--
-- If those RPCs never read estimated_price, the P&L was never wrong from this
-- bug and the honest answer is "it does not need fixing, Live Sales did".
-- If they do, it is a different and larger job.

DO $p$
DECLARE r record; v_src text; n int;
BEGIN
  RAISE NOTICE '== do the P&L RPCs reference estimates or pending orders? ==';
  FOR r IN
    SELECT p.proname,
           (pg_get_functiondef(p.oid) ILIKE '%estimated_price%')   AS reads_estimated_price,
           (pg_get_functiondef(p.oid) ILIKE '%sales_orders%')      AS reads_sales_orders,
           (pg_get_functiondef(p.oid) ILIKE '%financial_events%')  AS reads_fec,
           (pg_get_functiondef(p.oid) ILIKE '%locked_est_price%')  AS reads_locked_est,
           length(pg_get_functiondef(p.oid))                       AS def_len
    FROM pg_proc p
    JOIN pg_namespace n2 ON n2.oid = p.pronamespace
    WHERE n2.nspname = 'public'
      AND p.proname IN ('get_monthly_pl_breakdown', 'get_pl_live_summary',
                        'get_asin_profit', 'get_authoritative_period_totals',
                        'get_fec_daily_shipment_totals')
    ORDER BY p.proname
  LOOP
    RAISE NOTICE '  % | estimated_price % | sales_orders % | financial_events % | locked_est % | % chars',
      rpad(r.proname, 32), r.reads_estimated_price, r.reads_sales_orders,
      r.reads_fec, r.reads_locked_est, r.def_len;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none of those functions exist)'; END IF;

  -- The other half: does the P&L exclude pending orders, or would a stuck
  -- Pending row carry an estimate into revenue anyway?
  RAISE NOTICE '';
  RAISE NOTICE '== how much non-US money is unsettled and estimate-backed? ==';
  FOR r IN
    SELECT COALESCE(so.marketplace, '?') AS mk,
           count(*) AS orders, sum(so.quantity) AS units,
           round(sum(so.estimated_price * so.quantity)::numeric, 2) AS est_native
    FROM public.sales_orders so
    WHERE so.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
      AND COALESCE(so.sold_price, 0) = 0
      AND COALESCE(so.estimated_price, 0) > 0
      AND COALESCE(so.is_cancelled, false) = false
      AND so.order_id NOT LIKE '%-REFUND'
    GROUP BY 1 ORDER BY est_native DESC
  LOOP
    RAISE NOTICE '  % | % orders | % units | % of estimated revenue (native currency)',
      rpad(r.mk, 4), lpad(r.orders::text, 6), lpad(r.units::text, 6), r.est_native;
  END LOOP;

  -- And how long do these sit? order_status never updates, so "pending" can be
  -- a permanent condition rather than a few days.
  RAISE NOTICE '';
  RAISE NOTICE '== age of unsettled estimate-backed orders ==';
  FOR r IN
    SELECT CASE
             WHEN order_date > current_date - 7   THEN '1. under a week'
             WHEN order_date > current_date - 30  THEN '2. 1-4 weeks'
             WHEN order_date > current_date - 90  THEN '3. 1-3 months'
             ELSE                                      '4. over 3 months'
           END AS age,
           count(*) AS orders,
           round(sum(estimated_price * quantity)::numeric, 2) AS est_total
    FROM public.sales_orders
    WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
      AND COALESCE(sold_price, 0) = 0 AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | % estimated', rpad(r.age, 20), lpad(r.orders::text, 6), r.est_total;
  END LOOP;
END
$p$;
