-- READ-ONLY PROBE. Two return-rate numbers are in play and they disagree by
-- two orders of magnitude:
--   * the extension's reorder card says 17.5% for one ASIN (100 of 572),
--     sourced from asin_return_stats;
--   * yesterday's profit-band analysis read sales_orders.refund_quantity and
--     found 0.1-1.3% account-wide.
--
-- A 0.2% account-wide return rate is implausible for Amazon retail, so the
-- likelihood is that refund_quantity is sparsely populated and the band
-- analysis understated returns everywhere. Establish which source is
-- trustworthy before any buying advice rests on either.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== source 1: sales_orders.refund_quantity (what the band analysis used) ==';
  FOR r IN SELECT count(*) AS orders,
                  sum(quantity) AS units_sold,
                  sum(COALESCE(refund_quantity, 0)) AS units_refunded,
                  count(*) FILTER (WHERE COALESCE(refund_quantity, 0) > 0) AS orders_with_refund,
                  count(*) FILTER (WHERE refund_quantity IS NULL) AS refund_qty_null,
                  round((100.0 * sum(COALESCE(refund_quantity, 0)) / NULLIF(sum(quantity), 0))::numeric, 2) AS rate_pct
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date >= '2026-01-01'
             AND COALESCE(is_cancelled, false) = false LOOP
    RAISE NOTICE '  2026: % orders, % units sold, % units refunded (% orders flagged) -> % pct',
      r.orders, r.units_sold, r.units_refunded, r.orders_with_refund, r.rate_pct;
    RAISE NOTICE '        refund_quantity IS NULL on % orders', r.refund_qty_null;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== source 2: asin_return_stats (what the extension shows) ==';
  FOR r IN SELECT count(*) AS asins,
                  sum(units_sold) AS units_sold,
                  sum(units_returned) AS units_returned,
                  round((100.0 * sum(units_returned) / NULLIF(sum(units_sold), 0))::numeric, 2) AS rate_pct
           FROM public.asin_return_stats WHERE user_id = v_uid LOOP
    RAISE NOTICE '  % ASINs | % units sold | % returned -> % pct',
      r.asins, r.units_sold, r.units_returned, r.rate_pct;
  END LOOP;

  RAISE NOTICE '';
  -- (source 3 removed: live_refunds_cache has no refund_date column. The query
  --  failed and blocked the migration queue, hence an edit rather than a delete.)

  RAISE NOTICE '== the worst return offenders by rate (10+ units sold) ==';
  FOR r IN SELECT asin, units_sold, units_returned,
                  round((100.0 * units_returned / NULLIF(units_sold, 0))::numeric, 1) AS rate_pct
           FROM public.asin_return_stats
           WHERE user_id = v_uid AND units_sold >= 10
           ORDER BY (1.0 * units_returned / NULLIF(units_sold, 0)) DESC NULLS LAST LIMIT 12 LOOP
    RAISE NOTICE '  % | % sold, % returned -> % pct', r.asin, r.units_sold, r.units_returned, r.rate_pct;
  END LOOP;
END
$p$;
