-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- B01LC9A6NS was created at 13:39 UTC and is still PENDING_VALIDATION 15
-- minutes later, so it is not on the COG page (which lists listings that pass
-- is_active_created_listing: NULL or ACTIVE) and was not auto-filled. How long
-- does validation normally take, is the validation worker running, and how
-- many listings are waiting?

DO $probe$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. this listing''s validation fields ========';
  FOR r IN
    SELECT to_jsonb(l) - 'supplier_links' - 'notes' AS j
    FROM public.created_listings l
    WHERE user_id = v_uid AND asin = 'B01LC9A6NS'
  LOOP
    RAISE NOTICE '  %', r.j;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. listings waiting now ========';
  FOR r IN
    SELECT validation_status, count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest
    FROM public.created_listings
    WHERE user_id = v_uid AND validation_status NOT IN ('ACTIVE')
    GROUP BY 1
  LOOP
    RAISE NOTICE '  % : % rows, oldest %, newest %', r.validation_status, r.n, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. how long validation took, last 60 days ========';
  FOR r IN
    SELECT count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM validation_completed_at - created_at)) / 60 AS p50_min,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM validation_completed_at - created_at)) / 60 AS p90_min,
           max(EXTRACT(epoch FROM validation_completed_at - created_at)) / 60 AS max_min
    FROM public.created_listings
    WHERE user_id = v_uid AND validation_completed_at IS NOT NULL
      AND created_at > now() - interval '60 days'
  LOOP
    RAISE NOTICE '  % validated | median % min | 90th pct % min | slowest % min',
      r.n, round(r.p50_min::numeric, 1), round(r.p90_min::numeric, 1), round(r.max_min::numeric, 1);
  END LOOP;
  FOR r IN
    SELECT asin, validation_status, created_at, validation_started_at, validation_completed_at, validation_attempts,
           round(EXTRACT(epoch FROM validation_completed_at - created_at) / 60, 1) AS mins
    FROM public.created_listings
    WHERE user_id = v_uid AND validation_started_at IS NOT NULL
    ORDER BY created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '  % % created % started % completed % attempts=% -> % min',
      r.asin, rpad(r.validation_status, 18), r.created_at, r.validation_started_at, r.validation_completed_at,
      r.validation_attempts, r.mins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. the validation worker ========';
  FOR r IN
    SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%validation%' OR command ILIKE '%validat%'
  LOOP
    RAISE NOTICE '  job % % | % | active=%', r.jobid, r.jobname, r.schedule, r.active;
  END LOOP;
  FOR r IN
    SELECT d.jobid, count(*) AS runs,
           count(*) FILTER (WHERE d.status = 'succeeded') AS ok,
           count(*) FILTER (WHERE d.status = 'failed') AS failed,
           max(d.start_time) AS latest,
           left(max(d.return_message) FILTER (WHERE d.status = 'failed'), 80) AS last_fail
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE (j.jobname ILIKE '%validation%' OR j.command ILIKE '%validat%')
      AND d.start_time > now() - interval '1 hour'
    GROUP BY d.jobid
  LOOP
    RAISE NOTICE '  job % last hour: % runs, % ok, % failed, latest % | %', r.jobid, r.runs, r.ok, r.failed, r.latest, COALESCE(r.last_fail, '');
  END LOOP;
  FOR r IN
    SELECT status_code, left(content::text, 160) AS body, created
    FROM net._http_response
    WHERE content::text ILIKE '%validat%'
    ORDER BY created DESC LIMIT 5
  LOOP
    RAISE NOTICE '  worker response % at %: %', r.status_code, r.created, r.body;
  END LOOP;
END
$probe$;
