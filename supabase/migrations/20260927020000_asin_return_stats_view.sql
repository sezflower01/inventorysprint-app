-- Return history per ASIN, for the buying decision.
--
-- Seller request 2026-09-27: when adding a purchase in the create extension,
-- show how many of this ASIN came back before committing money to more of it.
--
-- ---- WHICH SOURCE -------------------------------------------------------
-- sales_orders.refund_quantity, NOT financial_events_cache. Measured today:
-- FEC holds 5,002 refund rows but keys them by SKU in its `asin` column (one
-- distinct value across the whole table), so it cannot answer "how many of
-- THIS ASIN came back". The two sources also agree on only 45 of ~1,700
-- refunded orders in 2026 -- they are matched differently -- so mixing them
-- would produce a number neither source supports. sales_orders is ASIN-keyed
-- and covers 6,021 refunded rows across 1,554 ASINs since 2023-12.
--
-- ---- WHAT IT DOES NOT CLAIM --------------------------------------------
-- A return is counted in the window its ORDER falls in, and a refund can post
-- months after the sale: B08HGZ2HXT reads 75 returns against 63 units sold
-- (119%) because its sales predate the rows we hold. The view therefore
-- exposes the raw counts and lets the caller show the rate as approximate --
-- it does not silently clamp a rate to 100% and pretend the mismatch is not
-- there.
--
-- security_invoker so the caller's own RLS on sales_orders applies: a user
-- sees only their own returns, and the extension can read it with the user's
-- token like any other table.

CREATE OR REPLACE VIEW public.asin_return_stats
WITH (security_invoker = true) AS
SELECT
  o.user_id,
  o.asin,
  sum(o.quantity)::int                                              AS units_sold,
  sum(COALESCE(o.refund_quantity, 0))::int                          AS units_returned,
  count(*) FILTER (WHERE COALESCE(o.refund_quantity, 0) > 0)::int   AS orders_returned,
  count(*)::int                                                     AS orders_total,
  round(100.0 * sum(COALESCE(o.refund_quantity, 0)) / NULLIF(sum(o.quantity), 0), 1) AS return_rate_pct,
  max(o.order_date) FILTER (WHERE COALESCE(o.refund_quantity, 0) > 0) AS last_return_date,
  min(o.order_date)                                                 AS first_sale_date,
  max(o.order_date)                                                 AS last_sale_date,
  -- Last 12 months, the window that reflects how the product behaves now.
  sum(o.quantity) FILTER (WHERE o.order_date >= current_date - 365)::int AS units_sold_12m,
  sum(COALESCE(o.refund_quantity, 0)) FILTER (WHERE o.order_date >= current_date - 365)::int AS units_returned_12m
FROM public.sales_orders o
WHERE COALESCE(o.is_cancelled, false) = false
  AND o.asin IS NOT NULL
  AND o.asin <> 'UNKNOWN'
GROUP BY o.user_id, o.asin;

REVOKE ALL ON public.asin_return_stats FROM PUBLIC, anon;
GRANT SELECT ON public.asin_return_stats TO authenticated;

COMMENT ON VIEW public.asin_return_stats IS
  'Per-ASIN return history from sales_orders.refund_quantity (NOT financial_events_cache, which is SKU-keyed and cannot answer per-ASIN). Read by the create extension before a purchase. A refund can post long after its sale, so return_rate_pct can exceed 100% on ASINs whose sales predate the stored orders — show it as approximate.';

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT count(*) AS asins, count(*) FILTER (WHERE units_returned > 0) AS with_returns
           FROM public.asin_return_stats LOOP
    RAISE NOTICE 'view covers % ASINs, % with at least one return', r.asins, r.with_returns;
  END LOOP;
  FOR r IN SELECT asin, units_sold, units_returned, return_rate_pct, last_return_date
           FROM public.asin_return_stats WHERE units_returned > 0 ORDER BY units_returned DESC LIMIT 3 LOOP
    RAISE NOTICE '  % | sold % | returned % (% pct) | last %', r.asin, r.units_sold, r.units_returned, r.return_rate_pct, r.last_return_date;
  END LOOP;
END
$p$;
