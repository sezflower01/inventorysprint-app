-- PROBE (read-only): what is pulling assignments back onto Momentum Builder?
--
-- The bulk action is scoped to the loaded view and one marketplace, which
-- explains why most of the catalogue never moved. It does NOT explain
-- Momentum Smart falling from 525 assignments / 254 ASINs yesterday to
-- 510 / 251 today while Momentum Builder rose from 2,203 to 2,216.
--
-- Prime suspect: a default rule. Anything that creates or repairs an
-- assignment without an explicit rule will reach for is_default, and if that
-- is Momentum Builder it will quietly undo hand-assignment over and over.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== which rule is the default? ========';
  n := 0;
  FOR r IN
    SELECT name, id, is_default, is_enabled, created_at
    FROM public.repricer_rules WHERE is_default = true
  LOOP
    n := n + 1;
    RAISE NOTICE '   DEFAULT: % (id %) enabled=%', r.name, r.id, r.is_enabled;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no rule flagged is_default)'; END IF;
  IF n > 1 THEN RAISE NOTICE '   *** more than one default -- whichever is picked first wins ***'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== assignments created TODAY, and which rule they got ========';
  FOR r IN
    SELECT COALESCE(rr.name,'(no rule)') AS rule, count(*) AS n,
           min(a.created_at) AS first_seen, max(a.created_at) AS last_seen
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE a.created_at::date = current_date
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % : % new rows, % .. %', r.rule, r.n, r.first_seen, r.last_seen;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== updated but NOT created today -- i.e. rewritten ========';
  FOR r IN
    SELECT COALESCE(rr.name,'(no rule)') AS rule, a.marketplace, count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE a.updated_at::date = current_date
      AND a.created_at::date <> current_date
    GROUP BY 1,2 ORDER BY n DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % : % rows', r.rule, r.marketplace, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== Momentum Smart, by marketplace and enabled state ========';
  FOR r IN
    SELECT a.marketplace,
           count(*) AS total,
           count(*) FILTER (WHERE a.is_enabled) AS enabled,
           count(*) FILTER (WHERE a.updated_at > now() - interval '3 hours') AS touched_3h
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE rr.name = 'Momentum Smart'
    GROUP BY a.marketplace ORDER BY total DESC
  LOOP
    RAISE NOTICE '   % : % total, % enabled, % touched in 3h', r.marketplace, r.total, r.enabled, r.touched_3h;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how big is the whole US book? ========';
  FOR r IN
    SELECT count(*) AS us_rows,
           count(*) FILTER (WHERE is_enabled) AS us_enabled,
           count(DISTINCT asin) AS us_asins
    FROM public.repricer_assignments WHERE marketplace = 'US'
  LOOP
    RAISE NOTICE '   US: % assignments, % enabled, % distinct ASINs', r.us_rows, r.us_enabled, r.us_asins;
    RAISE NOTICE '   (a single bulk action can only cover what the table has LOADED)';
  END LOOP;
END
$probe$;
