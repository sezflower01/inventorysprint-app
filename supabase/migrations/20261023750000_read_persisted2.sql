-- Read from the DURABLE table, not from net._http_response.
DO $p$
DECLARE r record; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.repull_reports;
  RAISE NOTICE '== persisted reports: % ==', v_n;
  FOR r IN
    SELECT month, applied, captured_at,
           report->>'api_items' AS api_items,
           report->>'api_rows_after_dedupe' AS api_rows,
           report->>'stored_rows' AS stored_rows,
           report->>'api_signed_total' AS api_signed,
           report->>'stored_signed_total' AS stored_signed,
           report->>'api_clawback_total' AS claw,
           report->>'pages' AS pages,
           COALESCE(report->>'aborted', report->>'error', '-') AS problem
    FROM public.repull_reports ORDER BY captured_at
  LOOP
    RAISE NOTICE '   % | applied % | pages % | API % rows | stored % | claw % | %',
      COALESCE(r.month,'-'), r.applied, COALESCE(r.pages,'-'),
      COALESCE(r.api_rows,'-'), COALESCE(r.stored_rows,'-'), COALESCE(r.claw,'-'),
      left(r.problem,60);
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '   none yet -- June still running'; END IF;
END
$p$;
