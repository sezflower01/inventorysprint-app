-- Confirm the two urgent migrations landed, then show the March and April
-- pairings and the catch-all gate for all three months.
DO $p$
DECLARE v_uid uuid; r record; v_open int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== 1. cron: is my job gone? ==';
  FOR r IN SELECT jobid, jobname, active FROM cron.job WHERE jobname ILIKE '%repull%'
  LOOP RAISE NOTICE '   [%] % active %', r.jobid, r.jobname, r.active; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no repull cron job exists -- confirmed gone'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. RLS on every table this work created ==';
  FOR r IN
    SELECT c.relname AS t, c.relrowsecurity AS rls,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS pol
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname IN ('fec_repull_backup','fec_october_backup_20261022',
                        'fec_adjustment_backup_20261022','inventory_revive_backup_20261020',
                        'repull_schedule','repull_reports','pl_baseline_20261022')
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '   % | RLS % | % policies', rpad(r.t,34), r.rls, r.pol;
    IF NOT r.rls THEN v_open := v_open + 1; END IF;
  END LOOP;
  RAISE NOTICE '   tables still WITHOUT RLS: %', v_open;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. any other public table without RLS (the CI finding) ==';
  FOR r IN
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    ORDER BY c.relname LIMIT 25
  LOOP RAISE NOTICE '   %', r.t; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. CATCH-ALL GATE per month (0 = no unmapped AdjustmentType) ==';
  FOR r IN
    SELECT left(month,7) AS m,
           COALESCE(report->>'api_items_via_catchall','(field absent)') AS cnt,
           COALESCE(report->>'api_catchall_types','-') AS types
    FROM public.repull_reports
    WHERE report ? 'api_signed_total' AND applied = false
    ORDER BY month, captured_at DESC
  LOOP RAISE NOTICE '   % | via catch-all % | %', r.m, r.cnt, left(r.types,50); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '============ MARCH ============';
  PERFORM public.repull_residual_explain(v_uid,'2026-03-01');
  RAISE NOTICE '';
  RAISE NOTICE '============ APRIL ============';
  PERFORM public.repull_residual_explain(v_uid,'2026-04-01');
END
$p$;
