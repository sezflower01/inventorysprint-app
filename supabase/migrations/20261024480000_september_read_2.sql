-- Re-read SEPTEMBER, and if it is still absent, find out what pg_net saw.
-- READ-ONLY.
DO $p$
DECLARE r record; v_uid uuid; v_body jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_body := public.repull_find_report('2026-09-01'::date, false, NULL, true);

  IF v_body IS NOT NULL THEN
    RAISE NOTICE 'SEPTEMBER landed: items % | pages % | catch-all % | api % | stored % | clawbacks %',
      v_body->>'api_items', v_body->>'pages', v_body->>'api_items_via_catchall',
      v_body->>'api_signed_total', v_body->>'stored_signed_total',
      v_body->>'api_clawback_total';
    RETURN;
  END IF;

  RAISE NOTICE 'SEPTEMBER still absent. Diagnosing.';
  RAISE NOTICE '';
  RAISE NOTICE '== pg_net queue ==';
  FOR r IN SELECT count(*) AS n FROM net.http_request_queue
           WHERE url LIKE '%repull-month-adjustments%'
  LOOP RAISE NOTICE '   % repull calls queued', r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== recent pg_net responses (any url) ==';
  FOR r IN
    SELECT id, status_code, left(COALESCE(error_msg,'-'),80) AS err,
           to_char(created,'HH24:MI:SS') AS t,
           left(COALESCE(content,''),200) AS body
    FROM net._http_response
    ORDER BY id DESC LIMIT 6
  LOOP
    RAISE NOTICE '   [%] % | status % | err %', r.id, r.t, COALESCE(r.status_code::text,'-'), r.err;
    IF r.body <> '' THEN RAISE NOTICE '        %', r.body; END IF;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   net._http_response is empty (it is purged in batches)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== every report written in the last 20 minutes, any month ==';
  FOR r IN
    SELECT to_char(captured_at,'HH24:MI:SS') AS t, month, applied,
           COALESCE(report->>'api_signed_total','-') AS total,
           COALESCE(report->>'error', report->>'refused','-') AS problem
    FROM public.repull_reports
    WHERE captured_at >= now() - interval '20 minutes'
    ORDER BY captured_at
  LOOP RAISE NOTICE '   % | % | applied % | total % | problem %', r.t, r.month, r.applied, r.total, r.problem; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none -- nothing has reported in 20 minutes'; END IF;
END
$p$;
