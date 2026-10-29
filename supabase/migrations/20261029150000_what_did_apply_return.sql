DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== response for the apply call (17132) ==';
  FOR r IN
    SELECT id, status_code, COALESCE(error_msg,'-') AS err, timed_out,
           replace(left(regexp_replace(COALESCE(content,''), E'[\n\r\t ]+', ' ', 'g'), 700), '%','%%') AS body
    FROM net._http_response WHERE id = 17132
  LOOP
    RAISE NOTICE '   status % | timed_out % | err %', r.status_code, r.timed_out, r.err;
    RAISE NOTICE '   body: %', r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no response row yet for 17132'; END IF;

  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE id = 17132;
  RAISE NOTICE '   still queued: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== any applied report for May? ==';
  FOR r IN
    SELECT to_char(captured_at,'HH24:MI:SS') AS t, applied,
           COALESCE(report->>'wrote','-') AS wrote,
           COALESCE(report->>'error', report->>'refused','-') AS problem,
           COALESCE(report->>'api_clawback_total','-') AS claw
    FROM public.repull_reports WHERE left(month,7)='2026-05'
    ORDER BY captured_at DESC LIMIT 3
  LOOP RAISE NOTICE '   % | applied % | wrote % | problem % | claw %', r.t, r.applied, r.wrote, r.problem, r.claw; END LOOP;
END
$p$;
