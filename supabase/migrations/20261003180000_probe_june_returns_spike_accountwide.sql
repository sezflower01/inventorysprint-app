-- READ-ONLY PROBE. Two unrelated products spiked in the SAME month.
--
--   B0CKJNCZLY (a candle diffuser)  2026-06: 47 returns on 74 sold = 63.5%
--   B077DY3DRM (a speaker grill)    2026-06: 37 returns on 48 sold = 77.1%
--
-- Two separate quality faults landing in one month is a coincidence worth
-- testing, because the alternative explanation is much more likely and much
-- less alarming: a refund is dated when Amazon PROCESSES it, so a backlog
-- cleared in June would post against both products at once while neither
-- product changed at all.
--
-- If June is a spike account-wide, the per-ASIN "June problem" is an accounting
-- artefact and neither product needs investigating.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== account-wide, by month: units sold vs units returned ==';
  FOR r IN
    WITH sold AS (
      SELECT date_trunc('month', order_date) AS m, sum(quantity) AS u
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2025-10-01'
        AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
      GROUP BY 1),
    ret AS (
      SELECT date_trunc('month', order_date) AS m,
             sum(CASE WHEN order_id LIKE '%-REFUND'
                      THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                      ELSE COALESCE(refund_quantity, 0) END) AS u,
             count(DISTINCT asin) FILTER (
               WHERE COALESCE(refund_quantity, 0) > 0 OR order_id LIKE '%-REFUND') AS asins
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2025-10-01'
        AND COALESCE(is_cancelled, false) = false
      GROUP BY 1)
    SELECT to_char(COALESCE(s.m, t.m), 'YYYY-MM') AS mon,
           COALESCE(s.u, 0) AS sold, COALESCE(t.u, 0) AS ret, COALESCE(t.asins, 0) AS asins,
           round((100.0 * COALESCE(t.u, 0) / NULLIF(s.u, 0))::numeric, 1) AS rate
    FROM sold s FULL JOIN ret t ON t.m = s.m ORDER BY 1
  LOOP
    RAISE NOTICE '  % | sold % | returned % across % ASINs | % pct',
      r.mon, r.sold, r.ret, r.asins, COALESCE(r.rate::text, 'n/a');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== June 2026 in detail: which ASINs, and were they spread or concentrated? ==';
  FOR r IN
    SELECT asin,
           sum(CASE WHEN order_id LIKE '%-REFUND'
                    THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                    ELSE COALESCE(refund_quantity, 0) END) AS returned
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-06-01' AND order_date < '2026-07-01'
      AND COALESCE(is_cancelled, false) = false
    GROUP BY asin HAVING sum(CASE WHEN order_id LIKE '%-REFUND'
                    THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                    ELSE COALESCE(refund_quantity, 0) END) > 0
    ORDER BY 2 DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % | % returned', r.asin, r.returned;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== were June refunds posted on a few days or spread through the month? ==';
  FOR r IN
    SELECT order_date::date AS d, count(*) AS rows,
           sum(GREATEST(COALESCE(refund_quantity, 0), quantity)) AS units
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id LIKE '%-REFUND'
      AND order_date >= '2026-06-01' AND order_date < '2026-07-01'
    GROUP BY 1 ORDER BY 3 DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % | % rows | % units', r.d, r.rows, r.units;
  END LOOP;
END
$p$;
