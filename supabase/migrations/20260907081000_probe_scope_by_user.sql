-- PROBE (read-only): how much of what I reported was other users' data?
--
-- My earlier probes ran as postgres with no user filter, so every count they
-- produced was ACROSS ALL ACCOUNTS. The single-default migration exposed it:
-- it found no user with more than one default, and the uniqueness index
-- already existed -- so the "three default rules" I reported were three
-- different users each correctly having one.
--
-- That casts doubt on the other figures I quoted: 17 rules, 6,214 assignments,
-- "Momentum Builder 2,203 assignments / 929 ASINs", "Momentum Smart 254
-- ASINs". This re-runs them scoped to sezflower01@gmail.com so the seller gets
-- their own numbers.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'user_id for sezflower01@gmail.com: %', COALESCE(v_uid::text, '(not found)');

  RAISE NOTICE '';
  RAISE NOTICE '======== how many accounts are in these tables? ========';
  FOR r IN
    SELECT 'repricer_rules' AS tbl, count(DISTINCT user_id) AS users, count(*) AS rows
    FROM public.repricer_rules
    UNION ALL
    SELECT 'repricer_assignments', count(DISTINCT user_id), count(*)
    FROM public.repricer_assignments
    UNION ALL
    SELECT 'inventory', count(DISTINCT user_id), count(*) FROM public.inventory
  LOOP
    RAISE NOTICE '   %-22s : % users, % rows', r.tbl, r.users, r.rows;
  END LOOP;

  IF v_uid IS NULL THEN
    RAISE NOTICE 'cannot scope further without the user id';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== YOUR rules and counts ========';
  FOR r IN
    SELECT rr.name, rr.is_default, rr.is_enabled,
           count(a.id) AS assignments,
           count(a.id) FILTER (WHERE a.is_enabled) AS enabled,
           count(DISTINCT a.asin) AS asins
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a
           ON a.rule_id = rr.id AND a.user_id = rr.user_id
    WHERE rr.user_id = v_uid
    GROUP BY rr.id, rr.name, rr.is_default, rr.is_enabled
    ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   %-32s default=%-5s | % assignments | % enabled | % ASINs',
      left(r.name,32), r.is_default, r.assignments, r.enabled, r.asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== YOUR totals ========';
  FOR r IN
    SELECT count(*) AS rules FROM public.repricer_rules WHERE user_id = v_uid
  LOOP RAISE NOTICE '   rules: %', r.rules; END LOOP;
  FOR r IN
    SELECT count(*) AS a, count(*) FILTER (WHERE is_enabled) AS en,
           count(DISTINCT asin) AS asins, count(DISTINCT marketplace) AS mkts
    FROM public.repricer_assignments WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   assignments: % (% enabled) across % ASINs and % marketplaces',
      r.a, r.en, r.asins, r.mkts;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== YOUR Momentum split, per marketplace ========';
  FOR r IN
    SELECT a.marketplace, rr.name, count(*) AS n,
           count(*) FILTER (WHERE a.is_enabled) AS enabled
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE a.user_id = v_uid AND rr.name ILIKE '%Momentum%'
    GROUP BY a.marketplace, rr.name ORDER BY a.marketplace, n DESC
  LOOP
    RAISE NOTICE '   % | %-24s : % (% enabled)', r.marketplace, left(r.name,24), r.n, r.enabled;
  END LOOP;
END
$probe$;
