-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller wants the return history for an ASIN shown in the create extension,
-- before committing to a purchase. Which source can answer that, and how well?
--   * sales_orders.refund_quantity / refund_amount -- written by the order sync
--   * financial_events_cache event_type = 'refund' -- Amazon's settled refunds
-- Check coverage of both, and what a per-ASIN answer would look like.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT count(*) AS orders,
                  count(*) FILTER (WHERE COALESCE(refund_quantity,0) > 0) AS with_refund_qty,
                  count(*) FILTER (WHERE COALESCE(refund_amount,0) <> 0) AS with_refund_amt,
                  count(*) FILTER (WHERE COALESCE(is_cancelled,false)) AS cancelled,
                  min(order_date) AS first_order, max(order_date) AS last_order
           FROM public.sales_orders WHERE user_id = v_uid LOOP
    RAISE NOTICE 'sales_orders: % rows | refund_quantity>0 % | refund_amount<>0 % | cancelled % | % .. %',
      r.orders, r.with_refund_qty, r.with_refund_amt, r.cancelled, r.first_order, r.last_order;
  END LOOP;

  FOR r IN SELECT count(*) AS refund_rows, count(DISTINCT amazon_order_id) AS orders,
                  count(DISTINCT asin) AS asin_keys, min(event_date) AS first, max(event_date) AS last
           FROM public.financial_events_cache WHERE user_id = v_uid AND event_type = 'refund' LOOP
    RAISE NOTICE 'financial_events_cache refunds: % rows | % orders | % asin keys | % .. %',
      r.refund_rows, r.orders, r.asin_keys, r.first, r.last;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== do the two agree on how many orders were refunded (2026)? ==';
  FOR r IN
    WITH so AS (
      SELECT DISTINCT order_id FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(refund_quantity,0) > 0 AND order_date >= '2026-01-01'),
    fec AS (
      SELECT DISTINCT amazon_order_id AS order_id FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type = 'refund' AND event_date >= '2026-01-01')
    SELECT (SELECT count(*) FROM so) AS in_sales_orders,
           (SELECT count(*) FROM fec) AS in_fec,
           (SELECT count(*) FROM so JOIN fec USING (order_id)) AS in_both LOOP
    RAISE NOTICE '  sales_orders % | financial_events % | both %', r.in_sales_orders, r.in_fec, r.in_both;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst ASINs by returns (sales_orders, all time) ==';
  FOR r IN SELECT asin,
                  sum(quantity) AS units_sold,
                  sum(COALESCE(refund_quantity,0)) AS units_returned,
                  round(100.0 * sum(COALESCE(refund_quantity,0)) / NULLIF(sum(quantity),0), 1) AS pct,
                  max(order_date) FILTER (WHERE COALESCE(refund_quantity,0) > 0) AS last_return
           FROM public.sales_orders
           WHERE user_id = v_uid AND COALESCE(is_cancelled,false) = false
           GROUP BY 1 HAVING sum(COALESCE(refund_quantity,0)) > 0
           ORDER BY 3 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % | sold % | returned % (% pct) | last %', r.asin, r.units_sold, r.units_returned, r.pct, r.last_return;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many ASINs have any return at all ==';
  FOR r IN SELECT count(*) AS asins_with_returns FROM (
             SELECT asin FROM public.sales_orders
             WHERE user_id = v_uid AND COALESCE(refund_quantity,0) > 0 GROUP BY asin) x LOOP
    RAISE NOTICE '  %', r.asins_with_returns;
  END LOOP;
END
$p$;
