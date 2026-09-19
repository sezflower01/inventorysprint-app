-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Freshness of the Buy Box status auto-lower relies on, across EVERY covered
-- US listing (not just the 6 that fired). repricer-scheduler writes
-- last_buybox_status and last_sp_api_check_at in the same UPDATE (all three
-- write sites, index.ts ~572/593/601), so last_sp_api_check_at is the age of
-- the status. No join into repricer_ai_decisions -- that is what timed out.
--
-- The dangerous direction is a STALE "losing": the listing may have won the
-- Buy Box since, and auto-lower would still lower its floor.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _f AS
  SELECT a.id, a.asin, a.last_buybox_status AS st, a.last_sp_api_check_at AS checked,
         EXTRACT(EPOCH FROM (now() - a.last_sp_api_check_at)) / 60.0 AS age_min,
         COALESCE(inv.qty, 0) AS qty
  FROM public.repricer_assignments a
  JOIN public.repricer_rules ru ON ru.id = a.rule_id AND 'US' = ANY (ru.auto_lower_min_marketplaces)
  LEFT JOIN LATERAL (
    SELECT sum(COALESCE(i.available,0) + COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) AS qty
    FROM public.inventory i WHERE i.user_id = a.user_id AND i.asin = a.asin
  ) inv ON true
  WHERE a.user_id = v_uid AND a.marketplace = 'US' AND a.is_enabled AND a.status = 'active';

  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT COALESCE(st, '(null)') AS st, count(*) AS n,
                  count(*) FILTER (WHERE age_min <= 15) AS le15,
                  count(*) FILTER (WHERE age_min > 15 AND age_min <= 60) AS le60,
                  count(*) FILTER (WHERE age_min > 60 AND age_min <= 180) AS le180,
                  count(*) FILTER (WHERE age_min > 180 AND age_min <= 1440) AS le1d,
                  count(*) FILTER (WHERE age_min > 1440) AS gt1d,
                  count(*) FILTER (WHERE checked IS NULL) AS never,
                  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY age_min)::numeric, 1) AS p50
           FROM _f GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '% (%): <=15m % | 15-60m % | 1-3h % | 3-24h % | >1d % | never % | median % min',
      r.st, r.n, r.le15, r.le60, r.le180, r.le1d, r.gt1d, r.never, r.p50;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the risky set: in stock, status "losing", status older than 3 h ==';
  FOR r IN SELECT count(*) AS n FROM _f WHERE qty > 0 AND st = 'losing' AND (checked IS NULL OR age_min > 180) LOOP
    RAISE NOTICE '  %', r.n;
  END LOOP;
  FOR r IN SELECT asin, qty, round(age_min / 60, 1) AS age_h FROM _f
           WHERE qty > 0 AND st = 'losing' AND (checked IS NULL OR age_min > 180)
           ORDER BY age_min DESC NULLS FIRST LIMIT 10 LOOP
    RAISE NOTICE '  % stock % | status % h old', r.asin, r.qty, r.age_h;
  END LOOP;

  DROP TABLE _f;
END
$p$;
