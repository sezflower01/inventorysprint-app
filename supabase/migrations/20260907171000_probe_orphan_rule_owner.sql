-- PROBE (read-only): who owns rule 8362f6c1 -- the empty "Momentum Builder"
-- flagged as default?
--
-- The previous probe listed non-sezflower01 rules with an INNER JOIN to
-- auth.users and returned only one row, which cannot account for that rule.
-- An inner join silently drops any rule whose owner is no longer in
-- auth.users, so the likeliest answer is a deleted account leaving data
-- behind. LEFT JOIN settles it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== every rule, with owner resolved or not ========';
  FOR r IN
    SELECT rr.id, rr.name, rr.is_default, rr.user_id,
           COALESCE(u.email, '(NO auth.users ROW -- deleted account)') AS owner,
           (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = rr.id) AS assignments
    FROM public.repricer_rules rr
    LEFT JOIN auth.users u ON u.id = rr.user_id
    ORDER BY owner, assignments DESC
  LOOP
    RAISE NOTICE '   % | %-30s | default=% | % assignments | %',
      left(r.id::text,8), left(r.name,30), r.is_default, r.assignments, r.owner;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== data belonging to owners that no longer exist ========';
  FOR r IN
    SELECT 'repricer_rules' AS tbl, count(*) AS rows FROM public.repricer_rules rr
      WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = rr.user_id)
    UNION ALL
    SELECT 'repricer_assignments', count(*) FROM public.repricer_assignments a
      WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.user_id)
    UNION ALL
    SELECT 'inventory', count(*) FROM public.inventory i
      WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.user_id)
    UNION ALL
    SELECT 'sales_orders', count(*) FROM public.sales_orders s
      WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id)
  LOOP
    RAISE NOTICE '   %-24s : % orphaned rows', r.tbl, r.rows;
  END LOOP;
END
$probe$;
