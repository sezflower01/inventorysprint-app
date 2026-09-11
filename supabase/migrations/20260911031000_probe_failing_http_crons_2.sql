-- PROBE (read-only): name the jobs behind the failing pg_net requests.
--
-- The previous probe (20260911030000) established that all 71 HTTP cron jobs
-- call the same host, so no job has a bad URL -- the DNS timeouts are
-- intermittent resolution of the project's own address, fatal only to jobs
-- that allow the 5,000 ms default. But its 71-job inventory truncated the
-- output before the sections that attribute failures. This re-runs those
-- sections alone, one line per job.
--
-- Added: DNS failures by SECOND of the minute. If they cluster at :00, the
-- cause is burst concurrency -- a dozen every-minute jobs resolving the same
-- host in the same instant -- rather than any single job.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== A. active HTTP jobs on the 5000 ms default ========';
  FOR r IN
    SELECT jobid, jobname, schedule, username,
           substring(command FROM 'functions/v1/([a-zA-Z0-9_-]+)') AS fn,
           (command ~ 'eyJ[A-Za-z0-9_-]{10,}') AS jwt
    FROM cron.job
    WHERE active AND command ILIKE '%net.http%'
      AND COALESCE(substring(command FROM 'timeout_milliseconds\s*(?::=|=>)\s*([0-9]+)'), '5000') = '5000'
    ORDER BY schedule, jobname
  LOOP
    RAISE NOTICE '   [%] % % fn=% owner=% hardcoded_jwt=%',
      r.jobid, rpad(left(r.jobname,36),36), rpad(r.schedule,15), r.fn, r.username, r.jwt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== B. HTTP errors by status and body, last 3 hours ========';
  FOR r IN
    SELECT status_code,
           left(regexp_replace(COALESCE(content::text,''), '\s+', ' ', 'g'), 120) AS body,
           count(*) AS n
    FROM net._http_response
    WHERE created > now() - interval '3 hours' AND status_code >= 400
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % x%  %', r.status_code, r.n, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== C. DNS timeouts by second of the minute, last 3 hours ========';
  FOR r IN
    SELECT extract(second FROM created)::int AS sec,
           count(*) FILTER (WHERE error_msg LIKE '%DNS time: 5%') AS dns,
           count(*) AS total
    FROM net._http_response
    WHERE created > now() - interval '3 hours'
    GROUP BY 1
    HAVING count(*) FILTER (WHERE error_msg LIKE '%DNS time: 5%') > 0
    ORDER BY 1
  LOOP
    RAISE NOTICE '   :%  dns=%  of % requests', lpad(r.sec::text, 2, '0'), r.dns, r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== D. requests per minute-second burst (how crowded is :00?) ========';
  FOR r IN
    SELECT CASE WHEN extract(second FROM created) < 2 THEN ':00-:01' ELSE 'rest of minute' END AS window,
           count(*) AS requests,
           count(*) FILTER (WHERE error_msg LIKE '%DNS time: 5%') AS dns,
           round(100.0 * count(*) FILTER (WHERE error_msg LIKE '%DNS time: 5%') / NULLIF(count(*),0), 1) AS pct
    FROM net._http_response
    WHERE created > now() - interval '3 hours'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %  % requests, % DNS timeouts (%%%)', rpad(r.window,15), r.requests, r.dns, r.pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== E. timing attribution, top 25 (WEAK: shared seconds) ========';
  FOR r IN
    WITH runs AS (
      SELECT j.jobid, j.jobname, d.start_time
      FROM cron.job_run_details d
      JOIN cron.job j ON j.jobid = d.jobid
      WHERE j.active AND j.command ILIKE '%net.http%'
        AND d.start_time > now() - interval '3 hours'
    ),
    scored AS (
      SELECT ru.jobid, ru.jobname,
        (SELECT count(*) FROM runs o
          WHERE o.jobid <> ru.jobid
            AND o.start_time BETWEEN ru.start_time - interval '2 seconds'
                                 AND ru.start_time + interval '2 seconds') AS co,
        EXISTS (SELECT 1 FROM net._http_response x
                 WHERE x.created BETWEEN ru.start_time AND ru.start_time + interval '8 seconds'
                   AND x.error_msg LIKE '%DNS time: 5%') AS dns_fail,
        EXISTS (SELECT 1 FROM net._http_response x
                 WHERE x.created BETWEEN ru.start_time AND ru.start_time + interval '8 seconds'
                   AND x.status_code >= 400) AS http_fail
      FROM runs ru
    )
    SELECT jobid, jobname, count(*) AS runs,
           count(*) FILTER (WHERE co = 0) AS solo,
           count(*) FILTER (WHERE dns_fail) AS dns_w,
           count(*) FILTER (WHERE dns_fail AND co = 0) AS dns_solo,
           count(*) FILTER (WHERE http_fail) AS http_w,
           count(*) FILTER (WHERE http_fail AND co = 0) AS http_solo
    FROM scored GROUP BY jobid, jobname
    ORDER BY count(*) FILTER (WHERE (dns_fail OR http_fail) AND co = 0) DESC,
             count(*) FILTER (WHERE dns_fail OR http_fail) DESC
    LIMIT 25
  LOOP
    RAISE NOTICE '   [%] % runs=% solo=% dns=%(solo %) http=%(solo %)',
      r.jobid, rpad(left(r.jobname,34),34), r.runs, r.solo, r.dns_w, r.dns_solo, r.http_w, r.http_solo;
  END LOOP;
END
$probe$;