-- READ-ONLY. Why did the button return non-2xx?
DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== policies on keepa_estimate_recheck_log ==';
  FOR r IN
    SELECT polname, polcmd::text AS cmd, pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS check_expr
    FROM pg_policy WHERE polrelid = 'public.keepa_estimate_recheck_log'::regclass
  LOOP
    RAISE NOTICE '   % | cmd % | using % | with check %', r.polname, r.cmd,
      COALESCE(r.using_expr,'-'), COALESCE(r.check_expr,'-');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (NO POLICIES AT ALL)'; END IF;

  SELECT count(*) INTO n FROM pg_policy
  WHERE polrelid='public.keepa_estimate_recheck_log'::regclass AND polcmd::text IN ('a','*');
  RAISE NOTICE '   -> INSERT-capable policies: % (0 means every insert is DENIED)', n;

  RAISE NOTICE '';
  RAISE NOTICE '== can the user UPDATE sales_orders? ==';
  FOR r IN
    SELECT polname, polcmd::text AS cmd
    FROM pg_policy WHERE polrelid='public.sales_orders'::regclass
    ORDER BY polcmd::text
  LOOP
    RAISE NOTICE '   % | cmd %', rpad(r.polname,52), r.cmd;
  END LOOP;
  RAISE NOTICE '   (cmd: r=SELECT w=UPDATE a=INSERT d=DELETE *=ALL)';
END
$p$;
