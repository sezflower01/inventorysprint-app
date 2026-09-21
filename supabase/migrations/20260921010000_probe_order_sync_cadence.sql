-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: Mobile Live Sales totals only rise when the page is OPENED on the
-- phone. The page polls the database every 5s while open but only asks Amazon
-- for new orders on open (startBackgroundSync). So if totals move only on
-- open, the server-side order pull is not landing orders in between.
-- Check: the order-sync cron jobs and their real outcomes, and WHEN today's
-- orders were written relative to when they were placed.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now %', now();

  RAISE NOTICE '== pg_cron jobs that pull orders ==';
  FOR r IN SELECT j.jobid, j.jobname, j.schedule, j.active,
                  (SELECT max(start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_run,
                  (SELECT count(*) FROM cron.job_run_details d WHERE d.jobid = j.jobid AND d.start_time > now() - interval '24 hours') AS runs_24h,
                  (SELECT count(*) FROM cron.job_run_details d WHERE d.jobid = j.jobid AND d.start_time > now() - interval '24 hours' AND d.status <> 'succeeded') AS failed_24h,
                  substring(j.command FROM 'functions/v1/([a-z0-9-]+)') AS fn,
                  (j.command ILIKE '%x-internal-secret%') AS uses_secret,
                  (j.command ILIKE '%Authorization%') AS uses_bearer
           FROM cron.job j
           WHERE j.command ILIKE '%order%' OR j.jobname ILIKE '%order%' OR j.jobname ILIKE '%sales%'
           ORDER BY j.jobid LOOP
    RAISE NOTICE '  #% % (%) active=% fn=% | last % | % runs, % failed in 24h | secret=% bearer=%',
      r.jobid, r.jobname, r.schedule, r.active, r.fn, r.last_run, r.runs_24h, r.failed_24h, r.uses_secret, r.uses_bearer;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what those calls actually got back (net._http_response, last 2h) ==';
  FOR r IN SELECT status_code, left(content, 160) AS body, count(*) AS n, max(created) AS last
           FROM net._http_response
           WHERE created > now() - interval '2 hours'
             AND (content ILIKE '%order%' OR content ILIKE '%sales%')
           GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 8 LOOP
    RAISE NOTICE '  HTTP % x% (last %) | %', r.status_code, r.n, r.last, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== today''s orders: when written vs when placed (UTC) ==';
  FOR r IN SELECT date_trunc('hour', created_at) AS written_hour,
                  count(*) AS orders,
                  round(avg(EXTRACT(EPOCH FROM (created_at - purchase_timestamp_utc)) / 60)::numeric, 0) AS avg_lag_min,
                  round(max(EXTRACT(EPOCH FROM (created_at - purchase_timestamp_utc)) / 60)::numeric, 0) AS max_lag_min,
                  count(DISTINCT date_trunc('minute', created_at)) AS distinct_write_minutes
           FROM public.sales_orders
           WHERE user_id = v_uid AND created_at > now() - interval '18 hours'
           GROUP BY 1 ORDER BY 1 DESC LOOP
    RAISE NOTICE '  % : % orders written in % distinct minutes | lag avg % min, max % min',
      r.written_hour, r.orders, r.distinct_write_minutes, r.avg_lag_min, r.max_lag_min;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the write bursts (minutes with 3+ orders written together) ==';
  FOR r IN SELECT date_trunc('minute', created_at) AS m, count(*) AS n
           FROM public.sales_orders
           WHERE user_id = v_uid AND created_at > now() - interval '18 hours'
           GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1 DESC LIMIT 15 LOOP
    RAISE NOTICE '  % : % orders', r.m, r.n;
  END LOOP;
END
$p$;
