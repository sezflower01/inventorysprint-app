-- READ ONLY. Who is the second account, and does it behave like a real person?
--
-- The operator needs the address to decide the cleanup, and it is their own
-- auth.users table, so there is nothing to withhold from them. It is NOT
-- written into this file: the repository is public, so the query selects the
-- value at run time and prints it to the operator's own terminal.
--
-- Beyond the address, the useful question is whether the account behaves like a
-- person or like a fixture. Three signals that do not require knowing them:
--
--   * does the local part match the operator's own address? A test account is
--     normally created from the operator's own mailbox, often with a +tag.
--   * is the sign-in history a single burst (a fixture) or spread out (a user)?
--   * did the account do anything a fixture would not bother to do?
DO $p$
DECLARE
  v_owner_email text;
  v_owner_local text;
  r record;
BEGIN
  SELECT email INTO v_owner_email FROM auth.users
   WHERE id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  v_owner_local := split_part(COALESCE(v_owner_email,''), '@', 1);

  RAISE NOTICE '=== the account ===';
  FOR r IN
    SELECT u.email,
           u.created_at,
           u.last_sign_in_at,
           u.email_confirmed_at IS NOT NULL AS confirmed,
           u.raw_app_meta_data->>'provider' AS provider,
           u.raw_user_meta_data->>'full_name' AS full_name,
           split_part(u.email,'@',1) AS local_part,
           split_part(u.email,'@',2) AS domain
    FROM auth.users u WHERE u.id::text LIKE 'e697c7c7%'
  LOOP
    RAISE NOTICE 'email            : %', r.email;
    RAISE NOTICE 'provider         : %', COALESCE(r.provider,'(none)');
    RAISE NOTICE 'full_name        : %', COALESCE(r.full_name,'(none)');
    RAISE NOTICE 'created          : %', r.created_at;
    RAISE NOTICE 'last sign-in     : %', COALESCE(r.last_sign_in_at::text,'never');
    RAISE NOTICE 'email confirmed  : %', r.confirmed;
    RAISE NOTICE ' ';
    RAISE NOTICE '--- is it derived from the operator''s own address? ---';
    RAISE NOTICE 'operator local part : %', v_owner_local;
    RAISE NOTICE 'this local part     : %', r.local_part;
    RAISE NOTICE 'shares the operator''s local part (a +tag or alias) : %',
      (r.local_part = v_owner_local
        OR r.local_part LIKE v_owner_local || '+%'
        OR v_owner_local LIKE r.local_part || '+%');
    RAISE NOTICE 'same domain as the operator : %',
      (r.domain = split_part(COALESCE(v_owner_email,''), '@', 2));
    RAISE NOTICE 'looks like a throwaway/test name : %',
      (r.local_part ~* '(test|demo|dev|qa|sample|dummy|temp|fake|staging)');
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== every other account, for comparison ===';
  FOR r IN
    SELECT left(id::text,8) AS u, email, created_at::date AS created,
           last_sign_in_at::date AS last_seen
    FROM auth.users ORDER BY created_at
  LOOP
    RAISE NOTICE '  % | % | created % | last seen %',
      r.u, rpad(r.email, 34), r.created, COALESCE(r.last_seen::text,'never');
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== behaviour: a burst, or spread out? ===';
  FOR r IN
    SELECT COUNT(*) AS runs,
           MIN(created_at)::date AS first_run,
           MAX(created_at)::date AS last_run,
           COUNT(DISTINCT created_at::date) AS distinct_days
    FROM public.auto_activate_runs
    WHERE user_id::text LIKE 'e697c7c7%'
  LOOP
    RAISE NOTICE 'auto_activate_runs: % runs over % distinct days (% .. %)',
      r.runs, r.distinct_days, r.first_run, r.last_run;
  END LOOP;

  FOR r IN
    SELECT module::text AS m, COUNT(*) AS n, MAX(created_at)::date AS last_used
    FROM public.module_usage WHERE user_id::text LIKE 'e697c7c7%'
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE 'module_usage: % used % time(s), last %', rpad(r.m,22), r.n, r.last_used;
  END LOOP;
END $p$;
