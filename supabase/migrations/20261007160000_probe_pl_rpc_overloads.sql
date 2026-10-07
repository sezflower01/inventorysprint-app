DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== two definitions each? list the signatures ==';
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           length(pg_get_functiondef(p.oid)) AS len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_monthly_pl_breakdown','get_pl_live_summary')
    ORDER BY p.proname, len
  LOOP
    RAISE NOTICE '  %(%) -- % chars', r.proname, r.args, r.len;
  END LOOP;
END
$p$;
