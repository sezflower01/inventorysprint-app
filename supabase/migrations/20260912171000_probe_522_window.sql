-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- 20260912170000 found the outage had passed by 23:20 UTC -- no locks, nothing
-- running long -- and that every "failed" Add Purchase had in fact committed:
-- B08HGY4PP8 / D03-GQA-ZTQ6 at 12 units $88.09 eight times 22:40-22:50, plus
-- one at $82.04 at 22:34. A 522 is Cloudflare timing out on the RESPONSE; the
-- insert behind it still lands, so every retry recorded the purchase again.
--
-- This reads, after the fact:
--   1. the duplicate row ids, so a cleanup can target exactly them;
--   2. whether trg_created_listings_cost_history copied each duplicate into
--      cost history -- the trigger fires on INSERT and UPDATE but NOT DELETE,
--      so deleting the created_listings rows alone would leave the copies;
--   3. what the database was doing in the 22:25-23:00 window, from what
--      survives: pg_cron outcomes per 5 minutes (a stalled instance shows as a
--      burst of "job startup timeout"), and the slowest statements on record.
--
-- An ANALYZE of asin_brand_cache and seller_catalog_queue ran at 22:29:59,
-- minutes before the first failure. Both had NEVER been analysed, so the
-- planner had been using default selectivity for them; real statistics can
-- change plans. That is a suspect, not a finding, and this is meant to test it.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. B08HGY4PP8 rows today, oldest first ========';
  FOR r IN
    SELECT id, created_at, units, cost, amount, date_created
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = 'B08HGY4PP8'
      AND created_at > now() - interval '12 hours'
    ORDER BY created_at
  LOOP
    RAISE NOTICE '  % | % | units=% cost=% unit=% | date_created=%',
      r.id, r.created_at, r.units, r.cost, r.amount, r.date_created;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. cost history copies ========';
  BEGIN
    FOR r IN
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cost_history'
      ORDER BY ordinal_position
    LOOP
      RAISE NOTICE '  cost_history column: %', r.column_name;
    END LOOP;
    FOR r IN
      EXECUTE $q$
        SELECT to_jsonb(c) AS j FROM public.cost_history c
        WHERE c.asin = 'B08HGY4PP8'
          AND c.created_at > now() - interval '12 hours'
        ORDER BY c.created_at
      $q$
    LOOP
      RAISE NOTICE '  %', r.j;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  could not read cost_history: %', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. pg_cron outcomes per 5 min, 22:00-23:25 UTC ========';
  FOR r IN
    SELECT to_timestamp(floor(EXTRACT(epoch FROM start_time) / 300) * 300) AS bucket,
           count(*) FILTER (WHERE status = 'succeeded') AS ok,
           count(*) FILTER (WHERE status = 'failed')    AS failed,
           count(*) FILTER (WHERE return_message ILIKE '%startup timeout%') AS startup_to,
           count(*) FILTER (WHERE return_message ILIKE '%statement timeout%') AS stmt_to,
           round(max(EXTRACT(epoch FROM end_time - start_time))) AS max_secs
    FROM cron.job_run_details
    WHERE start_time >= timestamptz '2026-09-12 22:00:00+00'
      AND start_time <  timestamptz '2026-09-12 23:25:00+00'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % ok=% failed=% startup_timeout=% stmt_timeout=% max=%s',
      to_char(r.bucket AT TIME ZONE 'UTC', 'HH24:MI'), lpad(r.ok::text, 4),
      lpad(r.failed::text, 3), lpad(r.startup_to::text, 3), lpad(r.stmt_to::text, 3), r.max_secs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3b. failures in the window, by job ========';
  FOR r IN
    SELECT d.jobid, j.jobname, count(*) AS n,
           min(d.start_time) AS first_at,
           left(max(d.return_message), 80) AS msg
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.status = 'failed'
      AND d.start_time >= timestamptz '2026-09-12 22:25:00+00'
      AND d.start_time <  timestamptz '2026-09-12 23:00:00+00'
    GROUP BY d.jobid, j.jobname
    ORDER BY n DESC
    LIMIT 12
  LOOP
    RAISE NOTICE '  job % % x% first % | %',
      lpad(r.jobid::text, 3), rpad(COALESCE(r.jobname, '(removed)'), 36), r.n,
      to_char(r.first_at AT TIME ZONE 'UTC', 'HH24:MI:SS'), r.msg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. slowest statements on record, touching the analysed tables ========';
  BEGIN
    FOR r IN
      SELECT calls, round(mean_exec_time) AS mean_ms, round(max_exec_time) AS max_ms,
             left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS q
      FROM extensions.pg_stat_statements
      WHERE query ILIKE '%seller_catalog_queue%'
         OR query ILIKE '%asin_brand_cache%'
         OR query ILIKE '%financial_events_cache%'
      ORDER BY max_exec_time DESC
      LIMIT 8
    LOOP
      RAISE NOTICE '  calls=% mean=%ms max=%ms | %', r.calls, r.mean_ms, r.max_ms, r.q;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  pg_stat_statements unavailable: %', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. slowest statements on record, anything ========';
  BEGIN
    FOR r IN
      SELECT calls, round(mean_exec_time) AS mean_ms, round(max_exec_time) AS max_ms,
             round(total_exec_time / 1000) AS total_s,
             left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS q
      FROM extensions.pg_stat_statements
      ORDER BY max_exec_time DESC
      LIMIT 8
    LOOP
      RAISE NOTICE '  calls=% mean=%ms max=%ms total=%s | %',
        r.calls, r.mean_ms, r.max_ms, r.total_s, r.q;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  pg_stat_statements unavailable: %', SQLERRM;
  END;
END
$probe$;
