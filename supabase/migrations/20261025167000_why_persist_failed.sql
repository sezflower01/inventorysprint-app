DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== RLS on repull_reports (persistReport writes here) ==';
  FOR r IN
    SELECT c.relrowsecurity AS rls,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='repull_reports'
  LOOP RAISE NOTICE '   RLS % | % policies', r.rls, r.policies; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== when did repull_reports last accept a row? ==';
  FOR r IN
    SELECT to_char(max(captured_at),'MM-DD HH24:MI:SS') AS newest, count(*) AS total
    FROM public.repull_reports
  LOOP RAISE NOTICE '   newest % | % rows total', r.newest, r.total; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== rows written today? ==';
  SELECT count(*) INTO v_n FROM public.repull_reports WHERE captured_at >= current_date;
  RAISE NOTICE '   % rows captured today', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== grants: can service_role still insert? ==';
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='repull_reports'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | %', rpad(r.grantee,20), r.privs; END LOOP;
END
$p$;
