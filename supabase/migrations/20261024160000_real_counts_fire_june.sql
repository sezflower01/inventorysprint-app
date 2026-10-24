-- n_live_tup read 0 for all nine because none has ever been analyzed
-- ("maint never"), so the planner has no estimate. Count them for real.
DO $p$
DECLARE v_uid uuid; r record; v_n bigint; v_sql text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== ITEM 5: REAL row counts ==';
  FOR r IN
    SELECT c.relname AS t, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    ORDER BY pg_total_relation_size(c.oid) DESC
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.t) INTO v_n;
    RAISE NOTICE '   % | % | % rows', rpad(r.t,42), lpad(r.size,10), v_n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 3: June dry run, fired alone ==';
  BEGIN v_req := public.repull_fire(v_uid,'2026-06-01',false);
  EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
END
$p$;
