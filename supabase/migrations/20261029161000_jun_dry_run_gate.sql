-- JUNE gate, against the dry run fired at 2026-10-30 00:01:54.932049+00.
--
-- repull_find_fresh_report returns NULL unless a report landed AFTER that
-- moment. NULL means STOP and re-read -- it is not "nothing to check". That
-- distinction is the whole reason the function exists.
--
-- Stop conditions, as approved:
--   rate_limit_hits        must be 0
--   api_items_via_catchall must be 0
--   api_clawback_total     must be -209.69  (confirmed from 7 stored reports)
--
-- NOTE ON FINGERPRINTS: June carries only THREE non-adjustment event types --
-- refund, service_fee, shipment. May had four (it also had liquidation). So
-- "four fingerprints identical" is not the right check for June; three is.
DO $p$
DECLARE b jsonb; v_hits int; v_catch int; v_claw numeric; v_ok boolean;
BEGIN
  b := public.repull_find_fresh_report('2026-06-01'::date, '2026-10-30 00:01:54.932049+00'::timestamptz);

  IF b IS NULL THEN
    RAISE NOTICE '############ NO FRESH JUNE REPORT YET ############';
    RAISE NOTICE '   The dry run has not landed. STOP -- re-read, do not proceed.';
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
