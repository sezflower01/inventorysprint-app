-- READ-ONLY PROBE. Creates nothing permanent, changes nothing.
-- Seller asks: listings filtered by "0 sales 7d / 30d" -- how do we make them
-- sell? First find out WHY each in-stock US listing is not selling:
-- suppressed, no data, blocked by its own min, priced above the market, or
-- already cheapest/winning (a demand problem that price alone won't fix).
-- Sales counted from sales_orders.order_date (Pacific), cancelled excluded.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _a AS
  SELECT a.id, a.asin, a.status, a.is_enabled, ru.name AS rule, a.last_buybox_status AS bb,
         a.min_price_override AS min_p, a.is_pricing_suppression AS supp, a.is_listing_inactive_not_buyable AS inactive,
         a.last_sp_api_check_at, a.last_price_change_at,
         inv.qty, inv.my_price, inv.bsr, inv.first_rx
  FROM public.repricer_assignments a
  LEFT JOIN public.repricer_rules ru ON ru.id = a.rule_id
  JOIN LATERAL (
    SELECT sum(COALESCE(i.available,0)) AS qty, max(COALESCE(i.my_price, i.price)) AS my_price,
           min(NULLIF(i.bsr,0)) AS bsr, min(i.first_received_at) AS first_rx
    FROM public.inventory i WHERE i.user_id = a.user_id AND i.asin = a.asin
  ) inv ON inv.qty > 0
  WHERE a.user_id = v_uid AND a.marketplace = 'US';

  CREATE TEMP TABLE _s AS
  SELECT asin,
         count(*) FILTER (WHERE order_date >= current_date - 7)  AS s7,
         count(*) FILTER (WHERE order_date >= current_date - 30) AS s30,
         count(*) FILTER (WHERE order_date >= current_date - 90) AS s90,
         count(*) AS s_all, max(order_date) AS last_sale
  FROM public.sales_orders
  WHERE user_id = v_uid AND COALESCE(is_cancelled, false) = false
    AND asin IN (SELECT asin FROM _a)
  GROUP BY asin;

  CREATE TEMP TABLE _z AS
  SELECT a.*, COALESCE(s.s7,0) s7, COALESCE(s.s30,0) s30, COALESCE(s.s90,0) s90, COALESCE(s.s_all,0) s_all, s.last_sale,
         sn.lowest_overall_price AS lowest, sn.buybox_price AS bbp, sn.fetched_at
  FROM _a a
  LEFT JOIN _s s ON s.asin = a.asin
  LEFT JOIN public.latest_competitor_snapshots(v_uid, (SELECT array_agg(DISTINCT asin) FROM _a), 'US') sn ON sn.asin = a.asin;

  RAISE NOTICE 'in-stock US assignments: % | 0 sales 7d: % | 0 sales 30d: %',
    (SELECT count(*) FROM _z), (SELECT count(*) FROM _z WHERE s7 = 0), (SELECT count(*) FROM _z WHERE s30 = 0);

  RAISE NOTICE '';
  RAISE NOTICE '== 0 sales in 30 days, by reason (first match wins) ==';
  FOR r IN
    WITH c AS (
      SELECT *, CASE
        WHEN NOT is_enabled OR status <> 'active' THEN '1 repricer off / paused (' || status || ')'
        WHEN supp OR inactive THEN '2 suppressed or inactive on Amazon'
        WHEN lowest IS NULL OR fetched_at < now() - interval '24 hours' THEN '3 no competitor data (24h)'
        WHEN bb IN ('winning','owned') THEN '4 winning Buy Box -- demand problem'
        WHEN my_price <= lowest + 0.005 THEN '5 already lowest -- demand problem'
        WHEN min_p IS NOT NULL AND min_p > lowest THEN '6 blocked by own min (min > lowest)'
        ELSE '7 above lowest, min allows lower'
      END AS reason
      FROM _z WHERE s30 = 0
    )
    SELECT reason, count(*) n,
           count(*) FILTER (WHERE s_all = 0) never_sold,
           count(*) FILTER (WHERE first_rx > now() - interval '30 days') new_30d,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY bsr)::numeric) med_bsr,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (my_price - lowest) / NULLIF(lowest,0) * 100)::numeric, 1) med_gap_pct,
           sum(qty) units
    FROM c GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '% : % listings (% units) | never sold % | received <30d % | median BSR % | median gap to lowest % pct',
      r.reason, r.n, r.units, r.never_sold, r.new_30d, r.med_bsr, r.med_gap_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 0 sales 30d: rule breakdown ==';
  FOR r IN SELECT COALESCE(rule,'(no rule)') rule, count(*) n FROM _z WHERE s30 = 0 GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % : %', r.rule, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== BSR of 0-sales-30d listings (demand signal; lower = sells more on Amazon) ==';
  FOR r IN SELECT CASE WHEN bsr IS NULL THEN '(no BSR)' WHEN bsr <= 50000 THEN 'a <=50k' WHEN bsr <= 200000 THEN 'b 50k-200k'
                       WHEN bsr <= 500000 THEN 'c 200k-500k' WHEN bsr <= 1000000 THEN 'd 500k-1M' ELSE 'e >1M' END b, count(*) n
           FROM _z WHERE s30 = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : %', r.b, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 0 sales 30d: time since last sale ==';
  FOR r IN SELECT CASE WHEN last_sale IS NULL THEN 'never sold' WHEN last_sale >= current_date - 90 THEN '30-90 days'
                       WHEN last_sale >= current_date - 180 THEN '90-180 days' ELSE '>180 days' END b, count(*) n
           FROM _z WHERE s30 = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : %', r.b, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== sample: winning BB or already lowest, still 0 sales 30d (best BSR first) ==';
  FOR r IN SELECT asin, my_price, lowest, bb, bsr, qty, last_sale FROM _z
           WHERE s30 = 0 AND is_enabled AND status = 'active' AND lowest IS NOT NULL
             AND (bb IN ('winning','owned') OR my_price <= lowest + 0.005)
           ORDER BY bsr NULLS LAST LIMIT 8 LOOP
    RAISE NOTICE '  % price % lowest % BB % | BSR % | stock % | last sale %', r.asin, r.my_price, r.lowest, r.bb, r.bsr, r.qty, r.last_sale;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== sample: above lowest, 0 sales 30d (biggest gap first) ==';
  FOR r IN SELECT asin, my_price, lowest, min_p, bb, bsr, qty FROM _z
           WHERE s30 = 0 AND is_enabled AND status = 'active' AND lowest IS NOT NULL AND my_price > lowest + 0.005
           ORDER BY (my_price - lowest) / lowest DESC LIMIT 8 LOOP
    RAISE NOTICE '  % price % lowest % min % BB % | BSR % | stock %', r.asin, r.my_price, r.lowest, r.min_p, r.bb, r.bsr, r.qty;
  END LOOP;

  DROP TABLE _z; DROP TABLE _s; DROP TABLE _a;
END
$p$;
