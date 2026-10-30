-- JUNE gate, re-read. Also reports the pg_net response for request 24545, so
-- "not landed yet" can be told apart from "the call failed".
--
-- On May I asserted the response had been dropped and persistReport had failed
-- silently. Both were wrong -- I had simply queried before it landed. Printing
-- the HTTP row removes the guesswork.
DO $p$
DECLARE b jsonb; r record; v_hits int; v_catch int; v_claw numeric; v_ok boolean; v_n int;
BEGIN
  RAISE NOTICE '== pg_net, request 24545 ==';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE id = 24545;
  RAISE NOTICE '   still queued (unsent): %', v_n;
  FOR r IN
    SELECT id, status_code, left(COALESCE(error_msg,'-'),80) AS err,
           left(COALESCE(content,''),200) AS body
    FROM net._http_response WHERE id = 24545
  LOOP
    RAISE NOTICE '   response: status % | err %', COALESCE(r.status_code::text,'-'), r.err;
    IF r.body <> '' THEN RAISE NOTICE '   body: %', replace(r.body,'%','%%'); END IF;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no HTTP response row yet -- still in flight'; END IF;

  RAISE NOTICE '';
  b := public.repull_find_fresh_report('2026-06-01'::date, '2026-10-30 00:01:54.932049+00'::timestamptz);

  IF b IS NULL THEN
    RAISE NOTICE '############ STILL NO FRESH JUNE REPORT -- STOP ############';
    RETURN;
  END IF;

  v_hits  := (b->>'rate_limit_hits')::int;
  v_catch := COALESCE((b->>'api_items_via_catchall')::int, -1);
  v_claw  := (b->>'api_clawback_total')::numeric;

  RAISE NOTICE '############ JUNE FRESH DRY RUN ############';
  RAISE NOTICE '   items % | pages % | elapsed % ms',
    b->>'api_items', b->>'pages', b->>'elapsed_ms';
  RAISE NOTICE '   stored total % -> api total %',
    b->>'stored_signed_total', b->>'api_signed_total';
  RAISE NOTICE '';
  RAISE NOTICE '   GATE 1 rate-limit hits   % | pass %', lpad(v_hits::text,5),  (v_hits = 0);
  RAISE NOTICE '   GATE 2 catch-all items   % | pass %', lpad(v_catch::text,5), (v_catch = 0);
  RAISE NOTICE '   GATE 3 clawbacks         % | pass % (recorded -209.69)',
    lpad(v_claw::text,9), (v_claw = -209.69);
  IF v_claw <> -209.69 THEN
    RAISE NOTICE '   !! DIFFERENCE: fresh % vs recorded -209.69, delta %',
      v_claw, round(v_claw - (-209.69), 2);
  END IF;
  RAISE NOTICE '   catch-all types %', b->'api_catchall_types';

  v_ok := (v_hits = 0 AND v_catch = 0 AND v_claw = -209.69);
  RAISE NOTICE '';
  IF v_ok THEN
    RAISE NOTICE '   ALL THREE GATES PASS -- clear to back up';
  ELSE
    RAISE NOTICE '   GATE FAILED -- stopping, nothing backed up, nothing applied';
  END IF;
END
$p$;
