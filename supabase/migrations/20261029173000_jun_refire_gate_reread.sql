-- JUNE gate, re-read of the re-fire (request 24663). Identical logic to
-- 20261029172000; the previous read found the call still in flight.
-- Same three stop conditions, unwaived:
--   rate_limit_hits        = 0
--   api_items_via_catchall = 0
--   api_clawback_total     = -209.69
--
-- NULL from repull_find_fresh_report means STOP and re-read, never "nothing to
-- check". The pg_net response is printed alongside so "not landed" is
-- distinguishable from "failed" without guessing, which is how I got the May
-- fire wrong.
DO $p$
DECLARE b jsonb; r record; v_hits int; v_catch int; v_claw numeric; v_n int;
BEGIN
  RAISE NOTICE '== pg_net, request 24663 ==';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE id = 24663;
  RAISE NOTICE '   still queued (unsent): %', v_n;
  FOR r IN
    SELECT status_code, left(COALESCE(error_msg,'-'),80) AS err
    FROM net._http_response WHERE id = 24663
  LOOP RAISE NOTICE '   response: status % | err %', COALESCE(r.status_code::text,'-'), r.err; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no HTTP response row yet -- still in flight'; END IF;

  RAISE NOTICE '';
  b := public.repull_find_fresh_report('2026-06-01'::date, '2026-10-30 00:11:48.374422+00'::timestamptz);

  IF b IS NULL THEN
    RAISE NOTICE '############ NO FRESH REPORT YET -- STOP, re-read ############';
    RETURN;
  END IF;

  v_hits  := (b->>'rate_limit_hits')::int;
  v_catch := COALESCE((b->>'api_items_via_catchall')::int, -1);
  v_claw  := (b->>'api_clawback_total')::numeric;

  RAISE NOTICE '############ JUNE RE-FIRE RESULT ############';
  RAISE NOTICE '   items % | pages % | elapsed % ms | rows after dedupe %',
    b->>'api_items', b->>'pages', b->>'elapsed_ms', b->>'api_rows_after_dedupe';
  RAISE NOTICE '   stored total % -> api total %',
    b->>'stored_signed_total', b->>'api_signed_total';
  RAISE NOTICE '';
  RAISE NOTICE '   GATE 1 rate-limit hits   % | pass %', lpad(v_hits::text,5),  (v_hits = 0);
  RAISE NOTICE '   GATE 2 catch-all items   % | pass %', lpad(v_catch::text,5), (v_catch = 0);
  RAISE NOTICE '   GATE 3 clawbacks         % | pass %', lpad(v_claw::text,9),  (v_claw = -209.69);
  IF v_claw <> -209.69 THEN
    RAISE NOTICE '   !! DIFFERENCE vs recorded -209.69: delta %', round(v_claw + 209.69, 2);
  END IF;

  RAISE NOTICE '';
  IF v_hits = 0 AND v_catch = 0 AND v_claw = -209.69 THEN
    RAISE NOTICE '   ALL THREE GATES PASS -- clear to back up';
  ELSE
    RAISE NOTICE '   GATE FAILED -- stop. Nothing backed up, nothing applied.';
  END IF;
END
$p$;
