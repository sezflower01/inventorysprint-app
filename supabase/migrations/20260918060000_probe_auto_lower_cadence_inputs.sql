-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller proposes per-rule auto-lower-min with a selectable interval
-- (5..60 min) plus an immediate re-evaluation. Before designing it:
--   1. how fresh is the competitor data auto-lower-min decides on
--      (repricer_competitor_snapshots per US auto-lower assignment)?
--   2. after a min is lowered, how soon is the assignment re-evaluated
--      (gap between the 13:40 lowers and the next decision rows)?
--   3. how are auto-lower assignments spread over the rules today?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== competitor snapshot age at this moment, US auto-lower assignments ==';
  FOR r IN
    WITH a AS (
      SELECT DISTINCT a.asin FROM public.repricer_assignments a
      WHERE a.user_id = v_uid AND a.is_enabled AND a.auto_lower_min_price AND a.marketplace = 'US'
    ), s AS (
      SELECT a.asin, max(cs.fetched_at) AS last_fetch
      FROM a LEFT JOIN public.repricer_competitor_snapshots cs ON cs.asin = a.asin AND cs.marketplace = 'US'
        AND cs.fetched_at > now() - interval '7 days'
      GROUP BY a.asin
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE last_fetch > now() - interval '5 minutes') AS lt5,
           count(*) FILTER (WHERE last_fetch > now() - interval '15 minutes') AS lt15,
           count(*) FILTER (WHERE last_fetch > now() - interval '60 minutes') AS lt60,
           count(*) FILTER (WHERE last_fetch IS NULL) AS none7d,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM now() - last_fetch) / 60)::numeric, 1) AS p50_min
    FROM s
  LOOP
    RAISE NOTICE '  ASINs % | fresher than 5 min % | 15 min % | 60 min % | none in 7 days % | median age % min',
      r.n, r.lt5, r.lt15, r.lt60, r.none7d, r.p50_min;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== snapshots per ASIN per hour (last 24 h), US auto-lower ASINs ==';
  FOR r IN
    WITH a AS (SELECT DISTINCT asin FROM public.repricer_assignments WHERE user_id = v_uid AND is_enabled AND auto_lower_min_price AND marketplace = 'US'),
         c AS (SELECT cs.asin, count(*) AS n FROM public.repricer_competitor_snapshots cs JOIN a USING (asin)
               WHERE cs.marketplace = 'US' AND cs.fetched_at > now() - interval '24 hours' GROUP BY cs.asin)
    SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY n / 24.0)::numeric, 2) AS p50_per_h,
           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY n / 24.0)::numeric, 2) AS p90_per_h,
           count(*) AS asins_with_any
    FROM c
  LOOP
    RAISE NOTICE '  median % snapshots/hour, p90 %/hour, over % ASINs', r.p50_per_h, r.p90_per_h, r.asins_with_any;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== after the 2026-09-17 13:40 lowers: next evaluation of those assignments ==';
  FOR r IN
    SELECT a.asin, a.min_price_override,
           (SELECT min(d.created_at) FROM public.repricer_ai_decisions d
             WHERE d.assignment_id = a.id AND d.created_at > '2026-09-16 13:40:03+00') AS next_eval
    FROM public.repricer_assignments a
    WHERE a.user_id = v_uid AND a.marketplace = 'US'
      AND a.asin IN ('B0C4Q8DLXN','B0F6KKKNJ6','B0H4WH84HR','B0H355GGTQ','B004J0FPFW')
  LOOP
    RAISE NOTICE '  % min % | next decision after the lower: % (% min later)', r.asin, r.min_price_override, r.next_eval,
      round(EXTRACT(EPOCH FROM (r.next_eval - '2026-09-16 13:40:03+00'::timestamptz)) / 60, 1);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== auto-lower assignments by rule ==';
  FOR r IN SELECT ru.name, a.marketplace, count(*) AS enabled,
                  count(*) FILTER (WHERE a.auto_lower_min_price) AS auto_lower
           FROM public.repricer_assignments a JOIN public.repricer_rules ru ON ru.id = a.rule_id
           WHERE a.user_id = v_uid AND a.is_enabled GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '  "%" %: % enabled, % with auto-lower', r.name, r.marketplace, r.enabled, r.auto_lower;
  END LOOP;
END
$p$;
