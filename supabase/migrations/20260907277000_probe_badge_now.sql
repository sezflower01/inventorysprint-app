-- PROBE (read-only): the seller reports the badge still reads 156 after the
-- orphan explanation. Check whether that is correct.
--
-- It should be. The badge counts enabled + ACTIVE + available > 0. An orphan
-- has NO inventory row, so it was never inside the 156 to begin with --
-- disabling orphans moves the tooltip totals (enabled / total ASINs) and leaves
-- the headline untouched. The headline only moves when stock moves.
--
-- Confirm that by reading the RPC the badge actually calls, plus the totals
-- underneath it, and whether the 06:15 UTC cleanup pass has run yet.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== exactly what the badge RPC returns right now ========';
  FOR r IN
    SELECT rr.name, c.assignments, c.enabled_assignments,
           c.distinct_asins, c.enabled_asins, c.in_stock_asins
    FROM public.get_rule_assignment_counts() c
    JOIN public.repricer_rules rr ON rr.id = c.rule_id
    WHERE rr.user_id = v_uid
    ORDER BY c.in_stock_asins DESC LIMIT 8
  LOOP
    RAISE NOTICE '   %  badge=%  enabled=%  total=%  (% assignments, % enabled)',
      rpad(left(r.name,26),26), r.in_stock_asins, r.enabled_asins,
      r.distinct_asins, r.assignments, r.enabled_assignments;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== has the cleanup run since 04:00 UTC? ========';
  FOR r IN
    SELECT date_trunc('hour', last_disabled_at) AS hr,
           COALESCE(last_disabled_by,'?') AS who, count(*) AS n
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND last_disabled_at > '2026-09-08 04:00:00+00'
    GROUP BY 1,2 ORDER BY 1
  LOOP
    RAISE NOTICE '   % by %  : % rows', r.hr, rpad(r.who,20), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== orphans still enabled ========';
  FOR r IN
    SELECT count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
  LOOP
    RAISE NOTICE '   % enabled assignments with no inventory row (was 242)', r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== could the badge move at all? whole-catalogue ceiling ========';
  FOR r IN
    SELECT count(*) AS rows_now,
           count(*) FILTER (WHERE upper(COALESCE(listing_status,'')) = 'ACTIVE') AS active,
           count(*) FILTER (WHERE upper(COALESCE(listing_status,'')) = 'ACTIVE'
             AND COALESCE(available,0) > 0) AS active_and_available
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % inventory rows | % ACTIVE | % ACTIVE with stock  <- ceiling',
      r.rows_now, r.active, r.active_and_available;
  END LOOP;
END
$probe$;
