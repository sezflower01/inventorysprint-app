-- The re-fire (request 24663) shows neither a queue row nor a response row.
-- Before concluding anything, look at pg_net and repull_reports WITHOUT
-- filtering on that id -- on May I asserted a response had been dropped when in
-- fact I had queried too early, so the id filter is exactly where that mistake
-- hides.
DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== most recent pg_net responses, any id ==';
  FOR r IN
    SELECT id, status_code, left(COALESCE(error_msg,'-'),60) AS err,
           to_char(created,'HH24:MI:SS') AS t
    FROM net._http_response ORDER BY created DESC LIMIT 8
  LOOP RAISE NOTICE '   [%] % | status % | err %', r.id, r.t,
         COALESCE(r.status_code::text,'-'), r.err; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   response table is EMPTY (pg_net prunes it)'; END IF;

  RAISE NOTICE '';
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '== request queue depth: % ==', v_n;
  FOR r IN
    SELECT id, left(url,70) AS url FROM net.http_request_queue ORDER BY id DESC LIMIT 5
  LOOP RAISE NOTICE '   [%] %', r.id, r.url; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== most recent June reports, any time ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t, rr.applied,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'api_items'          AS items,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_clawback_total' AS claw
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-06'
    ORDER BY rr.captured_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '   % | applied % | hits % | items % | pages % | claw %',
      r.t, r.applied, lpad(COALESCE(r.hits,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),4), lpad(COALESCE(r.claw,'-'),9);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== server time now: % ==', clock_timestamp();
  RAISE NOTICE '   fired_at was 2026-10-30 00:11:48.374422+00';
END
$p$;
