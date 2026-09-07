-- PROBE (read-only): whose account owns the rules that are not sezflower01's?
--
-- Every probe today that ran as postgres without a user filter reported across
-- all accounts, which is how "three default rules" and "17 rules" and "6,214
-- assignments" got quoted as this seller's numbers. They own the project, so
-- knowing what other accounts exist in their own database is a fair question
-- and answerable.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== accounts holding repricer data ========';
  FOR r IN
    SELECT u.email,
           u.created_at::date AS signed_up,
           u.last_sign_in_at::date AS last_seen,
           (SELECT count(*) FROM public.repricer_rules rr WHERE rr.user_id = u.id) AS rules,
           (SELECT count(*) FROM public.repricer_assignments a WHERE a.user_id = u.id) AS assignments,
           (SELECT count(*) FROM public.repricer_assignments a WHERE a.user_id = u.id AND a.is_enabled) AS enabled,
           (SELECT count(*) FROM public.inventory i WHERE i.user_id = u.id) AS inventory_rows,
           (SELECT count(*) FROM public.sales_orders s WHERE s.user_id = u.id) AS orders
    FROM auth.users u
    WHERE EXISTS (SELECT 1 FROM public.repricer_rules rr WHERE rr.user_id = u.id)
       OR EXISTS (SELECT 1 FROM public.repricer_assignments a WHERE a.user_id = u.id)
       OR EXISTS (SELECT 1 FROM public.inventory i WHERE i.user_id = u.id)
    ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   %-34s signed up % | last seen % | % rules | % assignments (% enabled) | % inventory | % orders',
      r.email, r.signed_up, COALESCE(r.last_seen::text,'never'),
      r.rules, r.assignments, r.enabled, r.inventory_rows, r.orders;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the rules NOT owned by sezflower01 ========';
  FOR r IN
    SELECT u.email, rr.name, rr.is_default, rr.is_enabled, rr.created_at::date AS created,
           (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = rr.id) AS assignments
    FROM public.repricer_rules rr
    JOIN auth.users u ON u.id = rr.user_id
    WHERE u.email <> 'sezflower01@gmail.com'
    ORDER BY u.email, rr.name
  LOOP
    RAISE NOTICE '   % | %-28s | default=% enabled=% | % assignments | created %',
      r.email, left(r.name,28), r.is_default, r.is_enabled, r.assignments, r.created;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== total accounts on the platform ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE last_sign_in_at > now() - interval '30 days') AS active_30d,
           count(*) FILTER (WHERE last_sign_in_at IS NULL) AS never_signed_in
    FROM auth.users
  LOOP
    RAISE NOTICE '   % accounts | % signed in within 30 days | % never signed in',
      r.total, r.active_30d, r.never_signed_in;
  END LOOP;
END
$probe$;
