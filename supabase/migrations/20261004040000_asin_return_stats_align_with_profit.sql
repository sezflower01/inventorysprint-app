-- Align asin_return_stats with get_asin_profit, so the extension and the Sales
-- Report stop disagreeing about the same ASIN.
--
-- B077DY3DRM showed three different "sold" counts on two screens:
--   337  this view, all time
--   333  this view, last 12 months
--   300  get_asin_profit, last 12 months
--
-- The view counted sum(quantity) over EVERY row, which means:
--   * "-REFUND" rows counted as SALES. They are refund records with a negative
--     sold_price and a quantity of their own, so each one added to units_sold
--     while its refund_quantity added to units_returned -- the same event
--     inflating both halves of the fraction, in opposite directions.
--   * zero-priced rows counted as sales. 1,324 of those exist across 354 ASINs
--     (the price-resolver fallback): fees charged, no revenue, not a sale.
--   * refund_quantity taken at face value. 48 rows carry a refund_quantity
--     LARGER than their order quantity -- 671 phantom units, 614 written by
--     inventory_refresh_forced over 24-27 June 2026. One claims 40 units
--     returned on an order that sold 1.
--
-- The old comment explained rates above 100% as refunds posting against sales
-- older than the stored orders. That is true in principle and was NOT the cause
-- here: B08HGZ2HXT's 75 returns on 63 units were 73 phantom units from a single
-- corrupt row. Clamping each row's returned units to the units it actually sold
-- removes the impossible arithmetic without hiding a real late refund, which
-- still counts -- just never more than once per unit shipped.
--
-- Returns now come from BOTH records, the way get_asin_profit counts them:
-- refund_quantity on a parent order, plus a "-REFUND" row's own quantity. For
-- B0CKJNCZLY 2026 that is 50 and 47 overlapping on 3 = 94, where either source
-- alone says 50 or 47.

CREATE OR REPLACE VIEW public.asin_return_stats
WITH (security_invoker = true) AS
WITH base AS (
  SELECT
    o.user_id,
    o.asin,
    o.order_date,
    o.order_id,
    (o.order_id LIKE '%-REFUND')                                   AS is_refund_row,
    (COALESCE(o.sold_price, 0) <= 0 AND o.order_id NOT LIKE '%-REFUND') AS zero_priced,
    o.quantity,
    -- A row cannot return more units than it sold. Clamped, not dropped: a
    -- genuine late refund still counts, just never more than once per unit.
    LEAST(COALESCE(o.refund_quantity, 0), o.quantity)              AS returned_clamped
  FROM public.sales_orders o
  WHERE COALESCE(o.is_cancelled, false) = false
    AND o.asin IS NOT NULL
    AND o.asin <> 'UNKNOWN'
), scored AS (
  SELECT
    user_id, asin, order_date, quantity,
    -- real sales only
    CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE quantity END AS sold_units,
    CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE 1 END        AS sold_order,
    -- a -REFUND row returns its own quantity; a parent returns refund_quantity
    CASE WHEN is_refund_row THEN quantity ELSE returned_clamped END AS returned_units,
    CASE WHEN (is_refund_row AND quantity > 0) OR returned_clamped > 0 THEN 1 ELSE 0 END AS returned_order,
    (is_refund_row OR returned_clamped > 0)                         AS is_return_event
  FROM base
)
SELECT
  user_id,
  asin,
  sum(sold_units)::int                                              AS units_sold,
  sum(returned_units)::int                                          AS units_returned,
  sum(returned_order)::int                                          AS orders_returned,
  sum(sold_order)::int                                              AS orders_total,
  round(100.0 * sum(returned_units) / NULLIF(sum(sold_units), 0), 1) AS return_rate_pct,
  max(order_date) FILTER (WHERE is_return_event)                    AS last_return_date,
  min(order_date) FILTER (WHERE sold_units > 0)                     AS first_sale_date,
  max(order_date) FILTER (WHERE sold_units > 0)                     AS last_sale_date,
  sum(sold_units) FILTER (WHERE order_date >= current_date - 365)::int     AS units_sold_12m,
  sum(returned_units) FILTER (WHERE order_date >= current_date - 365)::int AS units_returned_12m
FROM scored
GROUP BY user_id, asin;

REVOKE ALL ON public.asin_return_stats FROM PUBLIC, anon;
GRANT SELECT ON public.asin_return_stats TO authenticated;

COMMENT ON VIEW public.asin_return_stats IS
  'Per-ASIN return history from sales_orders, counted the SAME way as get_asin_profit: -REFUND rows and zero-priced rows are not sales, returns come from both parent refund_quantity and -REFUND rows, and a row cannot return more units than it sold (48 rows carried phantom quantities, 671 units, mostly written by inventory_refresh_forced in June 2026). Keep this definition and get_asin_profit in step: the extension reads this and the Sales Report reads that, and a seller comparing the two screens will notice any drift.';

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== before/after on the ASINs judged this week ==';
  FOR r IN SELECT asin, units_sold, units_returned, return_rate_pct,
                  units_sold_12m, units_returned_12m
           FROM public.asin_return_stats
           WHERE asin IN ('B077DY3DRM','B0CKJNCZLY','B0CYR1KRRL','B08HGZ2HXT','B077ZYJ3TB')
           ORDER BY asin LOOP
    RAISE NOTICE '  % | all time: % sold, % returned (% pct) | 12m: % sold, % returned',
      r.asin, r.units_sold, r.units_returned, r.return_rate_pct,
      r.units_sold_12m, r.units_returned_12m;
  END LOOP;
END
$p$;
