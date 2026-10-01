-- READ-ONLY PROBE. The revive cleared ghosted_at/ghost_reason on
-- B09PJPB34P -- proof the UPDATE landed -- yet listing_status is still
-- NOT_IN_CATALOG. Either a trigger overrode the column, or another writer put
-- it back within the minute. Look for both.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== triggers on public.inventory ==';
  FOR r IN SELECT t.tgname, p.proname, t.tgenabled,
                  pg_get_triggerdef(t.oid) AS def
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_proc p ON p.oid = t.tgfoid
           WHERE n.nspname = 'public' AND c.relname = 'inventory' AND NOT t.tgisinternal
           ORDER BY t.tgname LOOP
    RAISE NOTICE '  % -> % (enabled %)', r.tgname, r.proname, r.tgenabled;
    RAISE NOTICE '      %', left(r.def, 240);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no user triggers)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== does any trigger function mention listing_status? ==';
  FOR r IN SELECT p.proname, (pg_get_functiondef(p.oid) ~ 'listing_status') AS touches
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_proc p ON p.oid = t.tgfoid
           WHERE n.nspname = 'public' AND c.relname = 'inventory' AND NOT t.tgisinternal LOOP
    RAISE NOTICE '  % touches listing_status: %', r.proname, r.touches;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cron jobs that ran in the last 10 minutes ==';
  FOR r IN SELECT j.jobid, j.jobname, d.status, d.start_time, d.end_time
           FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
           WHERE d.start_time > now() - interval '10 minutes'
           ORDER BY d.start_time DESC LIMIT 25 LOOP
    RAISE NOTICE '  job % % | % | %', r.jobid, COALESCE(r.jobname, ''), r.status, r.start_time;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the row right now, with its update timestamps ==';
  FOR r IN SELECT sku, listing_status, ghosted_at, ghost_reason, source,
                  last_inventory_sync_at, updated_at, preserved_since
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  % | % | ghost %/% | source % | synced % | updated % | preserved %',
      r.sku, r.listing_status, r.ghosted_at, COALESCE(r.ghost_reason, ''), r.source,
      r.last_inventory_sync_at, r.updated_at, r.preserved_since;
  END LOOP;
END
$p$;
