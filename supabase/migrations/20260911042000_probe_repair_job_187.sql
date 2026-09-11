-- PROBE (read-only): job 187 repair-collapsed-orders-15min was absent from the
-- command read in 20260911040000, although the cron inventory at 13:15 UTC
-- listed it -- with secret=t vault=f, i.e. the internal secret was baked into
-- the command text by the format() call in 20260911022000 rather than read
-- from the vault at run time. Find out whether it still exists, and if it
-- unscheduled itself, which branch did it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_found boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  FOR r IN
    SELECT jobid, jobname, schedule, active,
           (command ~ '[A-Fa-f0-9]{40,}') AS literal_hex,
           (command ILIKE '%vault.decrypted_secrets%') AS vault
    FROM cron.job WHERE jobname ILIKE 'repair-collapsed-orders%'
  LOOP
    v_found := true;
    RAISE NOTICE '   EXISTS [%] % % active=% literal_hex_secret=% vault_at_runtime=%',
      r.jobid, r.jobname, r.schedule, r.active, r.literal_hex, r.vault;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE '   repair-collapsed-orders job does NOT exist'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== its runs since 12:50 UTC ========';
  FOR r IN
    SELECT d.jobid, d.status, d.start_time,
           left(regexp_replace(COALESCE(d.return_message,''), '\s+', ' ', 'g'), 200) AS msg
    FROM cron.job_run_details d
    WHERE d.jobid IN (187) OR d.command ILIKE '%repair-collapsed-orders%'
    ORDER BY d.start_time DESC LIMIT 8
  LOOP
    RAISE NOTICE '   [%] % % msg=%', r.jobid, r.start_time, r.status, r.msg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== progress ========';
  FOR r IN SELECT count(*) AS n, max(checked_at) AS latest FROM public.collapsed_order_checks
  LOOP RAISE NOTICE '   verdicts % (latest %)', r.n, r.latest; END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP RAISE NOTICE '   shortlist %', r.n; END LOOP;
  FOR r IN
    SELECT created, (content::jsonb ->> 'checks_recorded') AS rec, (content::jsonb ->> 'checked') AS chk
    FROM net._http_response WHERE content::text LIKE '%checks_recorded%'
    ORDER BY created DESC LIMIT 4
  LOOP
    RAISE NOTICE '   response % recorded=% checked=%', r.created, r.rec, r.chk;
  END LOOP;
END
$probe$;