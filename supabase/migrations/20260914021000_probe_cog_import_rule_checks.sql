-- READ-ONLY PROBE. Creates nothing, changes nothing, loads nothing.
--
-- 20260914020000 previewed the seed and exposed two weaknesses in its rule:
--
--   1. The outlier guard needs 3+ lots, so a placeholder lot inside a 1- or
--      2-lot ASIN passes straight through. B00LPP8BJQ: lots $0.01 and $12.12,
--      "average" $4.73. 2,047 ASINs are single-lot. Many 2024 lots were entered
--      as cost = $1 for hundreds of units -- placeholders, not purchases.
--   2. The all-time average blends old prices into 2026 costs. B01H0XM5D4:
--      2,746 units mostly from cheap older lots, all-time $9.92, last 12
--      months $11.04, latest lot $16.25, current 2026 sales $13.53.
--
-- This sizes both, compares candidate rules on 2026 COGS, and looks at the
-- two biggest changes the preview reported: B0G4BQ42W3 (+$5,129: 126 lots at
-- ~$14.77, sales costed at $9.62) and B0G1KRKM89 (+$1,133: $45.23 vs $16.18).

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  CREATE TEMP TABLE lots ON COMMIT DROP AS
  SELECT l.asin, l.units::numeric AS units, l.cost::numeric AS lot_total,
         (l.cost / l.units)::numeric AS unit, l.amount::numeric AS amount,
         CASE WHEN l.date_created::text ~ '^\d{4}-\d{2}-\d{2}'
              THEN left(l.date_created::text, 10)::date ELSE l.created_at::date END AS lot_date
  FROM public.created_listings l
  WHERE l.user_id = v_uid AND l.cost > 0 AND l.units > 0 AND l.asin ~ '^[A-Z0-9]{10}$';

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. placeholder lots ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE unit < 0.10) AS under_10c,
           count(*) FILTER (WHERE unit < 0.50) AS under_50c,
           count(*) FILTER (WHERE lot_total <= 1 AND units > 1) AS cost_le_1,
           count(DISTINCT asin) FILTER (WHERE unit < 0.10) AS asins_under_10c
    FROM lots
  LOOP
    RAISE NOTICE '  lots with unit < $0.10: % (in % ASINs) | unit < $0.50: % | lot total <= $1 for 2+ units: %',
      r.under_10c, r.asins_under_10c, r.under_50c, r.cost_le_1;
  END LOOP;
  FOR r IN
    WITH n AS (SELECT asin, count(*) AS n_lots FROM lots GROUP BY asin)
    SELECT count(DISTINCT l.asin) AS asins
    FROM lots l JOIN n USING (asin)
    WHERE n.n_lots < 3 AND l.unit < 0.10
  LOOP
    RAISE NOTICE '  ASINs with < 3 lots carrying a sub-$0.10 lot (missed by the outlier guard): %', r.asins;
  END LOOP;
  FOR r IN
    SELECT round(unit, 2) AS unit, count(*) AS n
    FROM lots WHERE unit < 0.50
    GROUP BY 1 ORDER BY n DESC LIMIT 8
  LOOP
    RAISE NOTICE '    unit $% : % lots', r.unit, r.n;
  END LOOP;
  FOR r IN
    SELECT extract(year FROM lot_date) AS yr, count(*) AS n
    FROM lots WHERE unit < 0.10
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '    sub-$0.10 lots dated %: %', r.yr, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. candidate rules, compared on 2026 COGS ========';
  RAISE NOTICE '  P = drop lots under $0.10/unit regardless of lot count, then the 3+-lot outlier guard';
  FOR r IN
    WITH clean0 AS (SELECT * FROM lots WHERE unit >= 0.10),
    med AS (SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS med, count(*) AS n FROM clean0 GROUP BY asin),
    clean AS (
      SELECT c.* FROM clean0 c JOIN med m USING (asin)
      WHERE NOT (c.units > 1 AND c.amount IS NOT NULL AND abs(c.lot_total - c.amount) < 0.005)
        AND NOT (m.n >= 3 AND (c.unit < m.med / 3.0 OR c.unit > m.med * 3.0))
    ),
    rules AS (
      SELECT asin,
             sum(lot_total) / sum(units) AS all_time,
             sum(lot_total) FILTER (WHERE lot_date >= current_date - 365)
               / NULLIF(sum(units) FILTER (WHERE lot_date >= current_date - 365), 0) AS m12
      FROM clean GROUP BY asin
    ),
    sold AS (
      SELECT asin, sum(quantity) AS qty, sum(total_cost) AS cogs
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2026-01-01' AND order_id NOT LIKE '%-REFUND'
        AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled') AND quantity > 0
      GROUP BY asin
    )
    SELECT count(*) AS asins,
           round(sum(s.cogs), 2) AS now_total,
           round(sum(r2.all_time * s.qty), 2) AS all_time_total,
           round(sum(COALESCE(r2.m12, r2.all_time) * s.qty), 2) AS m12_total,
           count(*) FILTER (WHERE r2.m12 IS NOT NULL) AS with_12m,
           count(*) FILTER (WHERE abs(r2.all_time * s.qty - s.cogs) > 100) AS big_all,
           count(*) FILTER (WHERE abs(COALESCE(r2.m12, r2.all_time) * s.qty - s.cogs) > 100) AS big_m12,
           round(sum(abs(r2.all_time * s.qty - s.cogs)), 2) AS absdiff_all,
           round(sum(abs(COALESCE(r2.m12, r2.all_time) * s.qty - s.cogs)), 2) AS absdiff_m12
    FROM rules r2 JOIN sold s USING (asin)
  LOOP
    RAISE NOTICE '  ASINs sold in 2026 and seedable: % (% have purchases in the last 12 months)', r.asins, r.with_12m;
    RAISE NOTICE '  2026 COGS now:                 $%', r.now_total;
    RAISE NOTICE '  all-time average:              $%  | ASINs moving > $100: % | total absolute movement $%',
      r.all_time_total, r.big_all, r.absdiff_all;
    RAISE NOTICE '  last-12-months (else all-time): $%  | ASINs moving > $100: % | total absolute movement $%',
      r.m12_total, r.big_m12, r.absdiff_m12;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. B0G4BQ42W3: lots ~$14.77 but 2026 sales costed $9.62 ========';
  FOR r IN
    SELECT COALESCE(cost_source_at_sale, '(null)') AS src, cost_locked,
           round(COALESCE(unit_cost_at_sale, unit_cost), 2) AS unit, count(*) AS n,
           min(order_date) AS first_d, max(order_date) AS last_d
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B0G4BQ42W3' AND order_date >= '2026-01-01'
      AND order_id NOT LIKE '%-REFUND'
    GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 8
  LOOP
    RAISE NOTICE '  src=% locked=% unit=$% x% (% to %)', rpad(r.src, 28), r.cost_locked, r.unit, r.n, r.first_d, r.last_d;
  END LOOP;
  FOR r IN
    SELECT to_char(lot_date, 'YYYY-MM') AS mon, count(*) AS lots, sum(units) AS units,
           round(sum(lot_total) / sum(units), 2) AS avg_unit
    FROM lots WHERE asin = 'B0G4BQ42W3' GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  lots %: % lots, % units, avg $%', r.mon, r.lots, r.units, r.avg_unit;
  END LOOP;
  FOR r IN
    SELECT effective_from, unit_cost, note FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND asin = 'B0G4BQ42W3' ORDER BY effective_from
  LOOP
    RAISE NOTICE '  override from %: $% (%)', r.effective_from, r.unit_cost, COALESCE(r.note, '-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. B0G1KRKM89: $45.23 average vs $16.18 in sales ========';
  FOR r IN SELECT lot_date, units, lot_total, round(unit, 2) AS unit, amount FROM lots WHERE asin = 'B0G1KRKM89' ORDER BY lot_date LOOP
    RAISE NOTICE '  lot %: % units, total $%, unit $%, amount %', r.lot_date, r.units, r.lot_total, r.unit, r.amount;
  END LOOP;
  FOR r IN
    SELECT COALESCE(cost_source_at_sale, '(null)') AS src,
           round(COALESCE(unit_cost_at_sale, unit_cost), 2) AS unit, count(*) AS n, sum(quantity) AS qty
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B0G1KRKM89' AND order_date >= '2026-01-01' AND order_id NOT LIKE '%-REFUND'
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 6
  LOOP
    RAISE NOTICE '  sales src=% unit=$% rows=% qty=%', rpad(r.src, 28), r.unit, r.n, r.qty;
  END LOOP;
  FOR r IN
    SELECT sku, title, round(avg(cost / NULLIF(units, 0)), 2) AS unit, sum(units) AS units
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = 'B0G1KRKM89'
    GROUP BY sku, title
  LOOP
    RAISE NOTICE '  listing sku=% unit=$% units=% | %', r.sku, r.unit, r.units, left(COALESCE(r.title, ''), 70);
  END LOOP;
END
$probe$;
