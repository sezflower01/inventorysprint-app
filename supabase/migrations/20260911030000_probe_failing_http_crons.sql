-- PROBE (read-only): which cron jobs are behind the failing pg_net requests?
--
-- Found while verifying the repair sweep: over the last hour, 984 pg_net
-- requests -> 623 ok, 254 HTTP errors, 107 timeouts, 102 of them spent entirely
-- in DNS ("Timeout of 5000 ms reached ... DNS time: 5000"). Steady at ~10% for
-- at least three hours.
--
-- The hard part: net._http_response keeps no URL. The request row is deleted
-- once processed, so a failed response cannot be traced to its job directly.
-- Attribution has to be indirect, and each method below is labelled for how
-- far it can be trusted.
--
--   1. TIMEOUT SIGNATURE (strong). pg_net's default timeout is 5,000 ms. A job
--      that passes its own timeout_milliseconds would fail with THAT number.
--      So "Timeout of 5000 ms" can only come from jobs that set no timeout or
--      set exactly 5000.
--   2. RESPONSE BODY (strong for errors). The body names who refused:
--      {"error":"Unauthorized"} is a function's own guard; a "code" like
--      UNAUTHORIZED_NO_AUTH_HEADER is the Supabase gateway refusing before the
--      function runs. Some bodies identify the function outright.
--   3. TIMING (weak). Match responses created within seconds of each job's
--      actual run start. Several jobs fire in the same second, so this gives a
--      share, not a verdict.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_text text;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== pg_net settings ========';
  FOR r IN
    SELECT name, setting FROM pg_settings WHERE name LIKE 'pg_net.%' ORDER BY name
  LOOP
    RAISE NOTICE '   % = %', r.name, r.setting;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== active HTTP cron jobs ========';
  FOR r IN
    SELECT jobid, jobname, schedule, active,
           substring(command FROM 'https?://[^/''"\s]+') AS host,
           substring(command FROM 'functions/v1/([a-zA-Z0-9_-]+)') AS fn,
           substring(command FROM 'timeout_milliseconds\s*(?::=|=>)\s*([0-9]+)') AS timeout_ms,
           (command ILIKE '%authorization%') AS sends_auth,
           (command ILIKE '%x-internal-secret%') AS sends_secret,
           (command ILIKE '%vault%') AS reads_vault,
           (command ~ 'eyJ[A-Za-z0-9_-]{10,}') AS hardcoded_jwt,
           username
    FROM cron.job
    WHERE command ILIKE '%http_post%' OR command ILIKE '%http_get%' OR command ILIKE '%net.http%'
    ORDER BY active DESC, schedule, jobname
  LOOP
    RAISE NOTICE '   [%] % | % | active=% | owner=%',
      r.jobid, rpad(left(r.jobname,38),38), rpad(r.schedule,16), r.active, r.username;
    RAISE NOTICE '        host=% fn=% timeout=% auth=% secret=% vault=% hardcoded_jwt=%',
      r.host, r.fn, COALESCE(r.timeout_ms,'DEFAULT(5000)'),
      r.sends_auth, r.sends_secret, r.reads_vault, r.hardcoded_jwt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== distinct hosts called ========';
  FOR r IN
    SELECT substring(command FROM 'https?://[^/''"\s]+') AS host,
           count(*) AS jobs, count(*) FILTER (WHERE active) AS active_jobs
    FROM cron.job
    WHERE command ILIKE '%net.http%'
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % : % jobs (% active)', r.host, r.jobs, r.active_jobs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== active jobs that would hit the 5000 ms default ========';
  FOR r IN
    SELECT jobid, jobname, schedule,
           substring(command FROM 'functions/v1/([a-zA-Z0-9_-]+)') AS fn
    FROM cron.job
    WHERE active
      AND command ILIKE '%net.http%'
      AND (substring(command FROM 'timeout_milliseconds\s*(?::=|=>)\s*([0-9]+)') IS NULL
           OR substring(command FROM 'timeout_milliseconds\s*(?::=|=>)\s*([0-9]+)') = '5000')
    ORDER BY schedule, jobname
  LOOP
    RAISE NOTICE '   [%] % | % | fn=%', r.jobid, rpad(left(r.jobname,38),38), rpad(r.schedule,16), r.fn;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== HTTP errors by status and body, last 3 hours ========';
  FOR r IN
    SELECT status_code,
           left(regexp_replace(COALESCE(content::text,''), '\s+', ' ', 'g'), 140) AS body,
           count(*) AS n, min(created) AS first_seen, max(created) AS last_seen
    FROM net._http_response
    WHERE created > now() - interval '3 hours' AND status_code >= 400
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 20
  LOOP
    RAISE NOTICE '   % x%  %', r.status_code, r.n, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== non-DNS timeouts and other errors, last 3 hours ========';
  FOR r IN
    SELECT left(regexp_replace(COALESCE(error_msg,''), '[0-9]+\.[0-9]+', 'N', 'g'), 120) AS err,
           count(*) AS n
    FROM net._http_response
    WHERE created > now() - interval '3 hours' AND error_msg IS NOT NULL
    GROUP BY 1 ORDER BY n DESC LIMIT 10
  LOOP
    RAISE NOTICE '   x%  %', r.n, r.err;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== timing attribution, last 3 hours (WEAK: shared seconds) ========';
  -- For each active HTTP job: of its actual runs, how many had a DNS timeout or
  -- an HTTP error created within 8 seconds of its start, and how many other
  -- jobs started in that same window. A job that fails while firing ALONE is a
  -- much stronger suspect than one that only fails in crowded seconds.
  FOR r IN
    WITH runs AS (
      SELECT j.jobid, j.jobname, d.start_time
      FROM cron.job_run_details d
      JOIN cron.job j ON j.jobid = d.jobid
      WHERE j.active AND j.command ILIKE '%net.http%'
        AND d.start_time > now() - interval '3 hours'
    ),
    scored AS (
      SELECT ru.jobid, ru.jobname, ru.start_time,
        (SELECT count(*) FROM runs o
          WHERE o.jobid <> ru.jobid
            AND o.start_time BETWEEN ru.start_time - interval '2 seconds'
                                 AND ru.start_time + interval '2 seconds') AS co_firing,
        EXISTS (SELECT 1 FROM net._http_response x
                 WHERE x.created BETWEEN ru.start_time AND ru.start_time + interval '8 seconds'
                   AND x.error_msg LIKE '%DNS time: 5%') AS dns_fail,
        EXISTS (SELECT 1 FROM net._http_response x
                 WHERE x.created BETWEEN ru.start_time AND ru.start_time + interval '8 seconds'
                   AND x.status_code >= 400) AS http_fail
      FROM runs ru
    )
    SELECT jobid, jobname,
           count(*) AS runs,
           count(*) FILTER (WHERE co_firing = 0) AS solo_runs,
           count(*) FILTER (WHERE dns_fail) AS dns_windows,
           count(*) FILTER (WHERE dns_fail AND co_firing = 0) AS dns_solo,
           count(*) FILTER (WHERE http_fail) AS http_windows,
           count(*) FILTER (WHERE http_fail AND co_firing = 0) AS http_solo
    FROM scored
    GROUP BY jobid, jobname
    ORDER BY (count(*) FILTER (WHERE (dns_fail OR http_fail) AND co_firing = 0)) DESC,
             count(*) FILTER (WHERE dns_fail OR http_fail) DESC
  LOOP
    RAISE NOTICE '   [%] % runs=% solo=% | dns: %/% solo | http: %/% solo',
      r.jobid, rpad(left(r.jobname,34),34), r.runs, r.solo_runs,
      r.dns_windows, r.dns_solo, r.http_windows, r.http_solo;
  END LOOP;
END
$probe$;