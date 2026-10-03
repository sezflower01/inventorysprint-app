-- READ-ONLY PROBE. Which ASINs actually have a returns problem?
--
-- Ranked by rate, but only where the volume makes a rate meaningful, and with
-- the money attached -- a 50% return rate on 4 units is noise, while 12% on
-- 1,400 units is real money. Return units are counted the way
-- get_asin_profit does: refund_quantity on parent orders PLUS separate
-- "-REFUND" rows, deduplicated, since neither source alone is complete.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _r ON COMMIT DROP AS
  WITH sold AS (
    SELECT asin, sum(quantity) AS units,
           sum(COALESCE(total_sale_amount, sold_price * quantity)) AS revenue
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
      AND COALESCE(is_cancelled, false) = false
      AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
    GROUP BY asin
  ), ret_parent AS (
    SELECT asin, sum(COALESCE(refund_quantity, 0)) AS u
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    GROUP BY asin
  ), ret_rows AS (
    SELECT asin, sum(GREATEST(COALESCE(refund_quantity, 0), quantity)) AS u,
           sum(COALESCE(refund_amount, 0)) AS amt
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
      AND COALESCE(is_cancelled, false) = false AND order_id LIKE '%-REFUND'
    GROUP BY asin
  ), overlap AS (
    SELECT rr.asin, sum(COALESCE(p.refund_quantity, 0)) AS u
    FROM public.sales_orders rr
    JOIN public.sales_orders p
      ON p.user_id = rr.user_id AND p.order_id = replace(rr.order_id, '-REFUND', '')
    WHERE rr.user_id = v_uid AND rr.order_date >= '2026-01-01'
      AND rr.order_id LIKE '%-REFUND' AND COALESCE(p.refund_quantity, 0) > 0
    GROUP BY rr.asin
  )
  SELECT s.asin, s.units, round(s.revenue::numeric, 2) AS revenue,
         GREATEST(0, COALESCE(rp.u, 0) + COALESCE(rr.u, 0) - COALESCE(o.u, 0))::int AS returned,
         round(COALESCE(rr.amt, 0)::numeric, 2) AS refund_amount
  FROM sold s
  LEFT JOIN ret_parent rp ON rp.asin = s.asin
  LEFT JOIN ret_rows rr ON rr.asin = s.asin
  LEFT JOIN overlap o ON o.asin = s.asin;

  RAISE NOTICE '== account-wide 2026 ==';
  FOR r IN SELECT sum(units) AS units, sum(returned) AS returned,
                  round((100.0 * sum(returned) / NULLIF(sum(units), 0))::numeric, 2) AS rate
           FROM _r LOOP
    RAISE NOTICE '  % units sold | % returned | % pct', r.units, r.returned, r.rate;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst RATE, 20+ units sold (rate is meaningless below that) ==';
  FOR r IN SELECT asin, units, returned, revenue,
                  round((100.0 * returned / NULLIF(units, 0))::numeric, 1) AS rate
           FROM _r WHERE units >= 20
           ORDER BY (1.0 * returned / NULLIF(units, 0)) DESC NULLS LAST LIMIT 15 LOOP
    RAISE NOTICE '  % | % sold, % returned -> % pct | revenue $%',
      r.asin, r.units, r.returned, r.rate, r.revenue;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst by UNITS returned (where the money actually is) ==';
  FOR r IN SELECT asin, units, returned, revenue,
                  round((100.0 * returned / NULLIF(units, 0))::numeric, 1) AS rate
           FROM _r ORDER BY returned DESC NULLS LAST LIMIT 15 LOOP
    RAISE NOTICE '  % | % returned of % sold (% pct) | revenue $%',
      r.asin, r.returned, r.units, r.rate, r.revenue;
  END LOOP;
END
$p$;
