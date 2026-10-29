DO $p$
DECLARE r record; b jsonb; v_n int;
BEGIN
  RAISE NOTICE '== does cron.job_run_details still hold 2026-10-24? ==';
  FOR r IN
    SELECT to_char(min(start_time),'MM-DD HH24:MI') AS oldest,
           to_char(max(start_time),'MM-DD HH24:MI') AS newest, count(*) AS rows
    FROM cron.job_run_details
  LOOP RAISE NOTICE '   retained % .. % | % rows', r.oldest, r.newest, r.rows; END LOOP;

  SELECT count(*) INTO v_n FROM cron.job_run_details
  WHERE start_time BETWEEN '2026-10-24 12:00+00' AND '2026-10-24 13:00+00';
  RAISE NOTICE '   rows from the 10-24 stall hour: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== every job-startup-timeout cluster still on record ==';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS t, count(*) AS jobs,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS held_s
    FROM cron.job_run_details d
    WHERE d.status <> 'succeeded' AND d.return_message ILIKE '%startup timeout%'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % jobs | held % s', r.t, r.jobs, r.held_s; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none on record'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ MAY GATE (fired 13:33:48) ############';
  b := public.repull_find_fresh_report('2026-05-01'::date, '2026-10-29 13:33:48.166693+00'::timestamptz);
  IF b IS NULL THEN
    RAISE NOTICE '   NO FRESH REPORT yet -- not landed. Re-read shortly.';
  ELSE
    RAISE NOTICE '   items % | pages % | elapsed % ms',
      b->>'api_items', b->>'pages', b->>'elapsed_ms';
    RAISE NOTICE '   hits % | catch-all % | types %',
      b->>'rate_limit_hits', b->>'api_items_via_catchall', b->'api_catchall_types';
    RAISE NOTICE '   stored % -> api % | clawbacks % (recorded -187.96)',
      b->>'stored_signed_total', b->>'api_signed_total', b->>'api_clawback_total';
    RAISE NOTICE '   GATES: hits=0 % | catchall=0 % | clawbacks match %',
      ((b->>'rate_limit_hits')::int = 0),
      ((b->>'api_items_via_catchall')::int = 0),
      ((b->>'api_clawback_total')::numeric = -187.96);
  END IF;
END
$p$;
