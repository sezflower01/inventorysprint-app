-- PROBE (read-only): settle a contradiction before calling the repair job fixed.
--
-- net._http_response holds a 200 from the NEW function (created 13:08:17 UTC):
--   checks_recorded=44 checked=48 already_correct=44 throttled=4
-- yet the verify probe at 13:10:05 read 0 rows in collapsed_order_checks and a
-- shortlist still at 290. Either that read was early, or the upsert reported
-- success without the rows landing. Count the rows now.
--
-- Also sizing a separate problem the same query exposed: many pg_net requests
-- from OTHER cron jobs are failing with "Timeout of 5000 ms reached" spent
-- entirely in DNS resolution.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== collapsed_order_checks, now ========';
  FOR r IN
    SELECT outcome, count(*) AS n, min(checked_at) AS first_at, max(checked_at) AS last_at
    FROM public.collapsed_order_checks
    GROUP BY outcome ORDER BY n DESC
  LOOP
    RAISE NOTICE '   %  % rows  (% .. %)', rpad(r.outcome,18), r.n, r.first_at, r.last_at;
  END LOOP;
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE user_id = v_uid) AS this_user,
           count(DISTINCT user_id) AS users
    FROM public.collapsed_order_checks
  LOOP
    RAISE NOTICE '   total % rows | % for this user | % distinct user_id', r.total, r.this_user, r.users;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist now (290 at reschedule, 48 checked at 13:07) ========';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP
    RAISE NOTICE '   % remain', r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== all responses from the new function ========';
  FOR r IN
    SELECT id, created,
           (content::jsonb ->> 'checks_recorded') AS recorded,
           (content::jsonb ->> 'checked') AS checked,
           (content::jsonb ->> 'throttled') AS throttled
    FROM net._http_response
    WHERE content::text LIKE '%checks_recorded%'
    ORDER BY created
  LOOP
    RAISE NOTICE '   id=% % recorded=% checked=% throttled=%',
      r.id, r.created, r.recorded, r.checked, r.throttled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== pg_net health, last 60 minutes ========';
  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE status_code BETWEEN 200 AND 299) AS ok_2xx,
      count(*) FILTER (WHERE status_code >= 400) AS http_errors,
      count(*) FILTER (WHERE error_msg LIKE '%Timeout%') AS timeouts,
      count(*) FILTER (WHERE error_msg LIKE '%DNS time: 5%') AS dns_timeouts,
      count(*) FILTER (WHERE error_msg IS NOT NULL AND error_msg NOT LIKE '%Timeout%') AS other_errors
    FROM net._http_response
    WHERE created > now() - interval '60 minutes'
  LOOP
    RAISE NOTICE '   % requests | % ok (2xx) | % HTTP errors | % timeouts (% in DNS) | % other errors',
      r.total, r.ok_2xx, r.http_errors, r.timeouts, r.dns_timeouts, r.other_errors;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== DNS timeouts by 10-minute bucket ========';
  FOR r IN
    SELECT to_char(date_trunc('hour', created) + floor(extract(minute FROM created)/10) * interval '10 minutes', 'HH24:MI') AS bucket,
           count(*) FILTER (WHERE error_msg LIKE '%DNS time: 5%') AS dns_to,
           count(*) FILTER (WHERE status_code BETWEEN 200 AND 299) AS ok,
           count(*) AS total
    FROM net._http_response
    WHERE created > now() - interval '3 hours'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %  dns_timeouts=%  ok=%  total=%', r.bucket, r.dns_to, r.ok, r.total;
  END LOOP;
END
$probe$;