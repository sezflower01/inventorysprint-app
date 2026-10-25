-- READ-ONLY. Does the P&L's COGS use a unit count, and where from?
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== the live get_monthly_cogs body ==';
  FOR r IN
    SELECT replace(left(regexp_replace(pg_get_functiondef(p.oid), E'\s+', ' ', 'g'), 1400), '%', '%%') AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='get_monthly_cogs' LIMIT 1
  LOOP RAISE NOTICE '%', r.def; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no such function'; END IF;
END
$p$;
