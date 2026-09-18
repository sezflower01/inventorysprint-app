-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Did the new auto-sync-sales-every-5-minutes job (1-56/5) fire, and did
-- sync-sales-orders accept it?

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT d.start_time, d.status, left(d.return_message, 80) AS msg
           FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
           WHERE j.jobname = 'auto-sync-sales-every-5-minutes'
           ORDER BY d.start_time DESC LIMIT 3 LOOP
    RAISE NOTICE '  cron run % status=% msg=%', r.start_time, r.status, r.msg;
  END LOOP;
  FOR r IN SELECT created, status_code, left(regexp_replace(COALESCE(content, error_msg, ''), '\s+', ' ', 'g'), 160) AS head
           FROM net._http_response
           WHERE created > '2026-09-18 12:05:00+00' AND COALESCE(content,'') ILIKE '%Sync started in background%'
           ORDER BY created DESC LIMIT 3 LOOP
    RAISE NOTICE '  sync-sales-orders answered at % s=% | %', r.created, r.status_code, r.head;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM cron.job WHERE jobname = 'auto-sync-sales-every-10-minutes-v2' LOOP
    RAISE NOTICE '  old 10-minute job still scheduled: % (expect 0)', r.n;
  END LOOP;
END
$p$;
