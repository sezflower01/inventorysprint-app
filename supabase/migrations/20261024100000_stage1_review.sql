-- Stage 1 review: status, July's clawback, the three residual explanations with
-- their pairings and api_items_via_catchall, and the full 2026 table.
--
-- api_items_via_catchall only exists on reports produced after the gate fix, so
-- its absence is reported as "report predates the field" rather than as zero --
-- a missing value and a measured zero are not the same claim.
DO $p$
DECLARE v_uid uuid; r record; v_jul jsonb; v_tot numeric; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== JOB 196 / repull-adjustments-2m ==';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
           WHERE jobname='repull-adjustments-2m'
  LOOP RAISE NOTICE '   [%] % | % | active %', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NOT scheduled (idle)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== STAGE 1 WORK LIST ==';
  FOR r IN
    SELECT seq, to_char(month,'YYYY-MM') AS m, status, attempts,
           COALESCE(left(note,46),'-') AS note
    FROM public.repull_schedule ORDER BY seq
  LOOP
    RAISE NOTICE '   % | % | % | att % | %', r.seq, r.m, rpad(r.status,7), r.attempts, r.note;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== last 6 cron runs ==';
  FOR r IN
    SELECT status, left(COALESCE(return_message,'-'),62) AS msg,
           to_char(start_time,'HH24:MI:SS') AS t
    FROM cron.job_run_details
    WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname='repull-adjustments-2m')
    ORDER BY start_time DESC LIMIT 6
  LOOP RAISE NOTICE '   % | % | %', r.t, rpad(r.status,9), r.msg; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no run details'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== reports captured, per month ==';
  FOR r IN
    SELECT left(month,7) AS m, count(*) AS n,
           max((report->>'api_clawback_total')::numeric) AS claw,
           bool_or(report ? 'api_amount_multiset') AS ms,
           bool_or(report ? 'api_items_via_catchall') AS has_gate,
           max((report->>'api_items_via_catchall')::int) AS catchall
    FROM public.repull_reports WHERE report ? 'api_signed_total'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % reports | claw % | multiset % | gate field % | catchall %',
      r.m, r.n, lpad(COALESCE(r.claw::text,'-'),9), r.ms, r.has_gate,
      COALESCE(r.catchall::text,'n/a');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== JULY ==';
  v_jul := public.repull_find_report('2026-07-01', false, NULL, false);
  IF v_jul IS NULL THEN
    RAISE NOTICE '   no July report yet';
  ELSE
    RAISE NOTICE '   API % rows / stored % | clawback % | predicted %',
      v_jul->>'api_rows_after_dedupe', v_jul->>'stored_rows',
      v_jul->>'api_clawback_total',
      round((v_jul->>'api_signed_total')::numeric - (v_jul->>'stored_signed_total')::numeric, 2);
    RAISE NOTICE '   via catch-all: %',
      COALESCE(v_jul->>'api_items_via_catchall','report predates the field');
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '============ RESIDUAL EXPLANATIONS ============';
  PERFORM public.repull_residual_explain(v_uid,'2026-02-01');
  PERFORM public.repull_residual_explain(v_uid,'2026-03-01');
  PERFORM public.repull_residual_explain(v_uid,'2026-04-01');

  RAISE NOTICE '';
  RAISE NOTICE '== api_items_via_catchall per month (the apply gate) ==';
  FOR r IN
    SELECT left(month,7) AS m,
           (report->>'api_items_via_catchall') AS cnt,
           COALESCE(report->>'api_catchall_types','-') AS types
    FROM public.repull_reports
    WHERE report ? 'api_signed_total' AND applied = false
      AND left(month,7) IN ('2026-02','2026-03','2026-04','2026-06','2026-07')
    ORDER BY month, captured_at DESC
  LOOP
    RAISE NOTICE '   % | % | %', r.m,
      COALESCE(r.cnt,'(field absent -- report predates the fix)'), left(r.types,60);
  END LOOP;
END
$p$;
