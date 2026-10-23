DO $p$
DECLARE v_body jsonb; v_status int; v_raw text;
BEGIN
  SELECT status_code, left(COALESCE(content,''),2000) INTO v_status, v_raw
  FROM net._http_response WHERE id = 37912;
  IF v_raw IS NULL THEN
    RAISE NOTICE '== 37912: pending | queue depth % ==',
      (SELECT count(*) FROM net.http_request_queue);
    RETURN;
  END IF;
  v_body := v_raw::jsonb;
  RAISE NOTICE '== HTTP % | wrote % | dry_run % ==', v_status,
    v_body->>'wrote', COALESCE(v_body->>'dry_run','-');
  IF v_body ? 'error'   THEN RAISE NOTICE '   ERROR: %',   v_body->>'error'; END IF;
  IF v_body ? 'aborted' THEN RAISE NOTICE '   ABORTED: %', v_body->>'aborted'; END IF;
  RAISE NOTICE '';
  RAISE NOTICE '   window % .. %', left(v_body->'window'->>'posted_after',19),
                                   left(v_body->'window'->>'posted_before',19);
  RAISE NOTICE '   pages % | rate limits % | elapsed % ms',
    v_body->>'pages', v_body->>'rate_limit_hits', v_body->>'elapsed_ms';
  RAISE NOTICE '';
  RAISE NOTICE '   API    items % -> % rows after dedupe', v_body->>'api_items', v_body->>'api_rows_after_dedupe';
  RAISE NOTICE '          % routed to nothing | % skipped as liquidation',
    v_body->>'api_items_routed_to_nothing', COALESCE(v_body->>'api_items_skipped_liquidation','-');
  RAISE NOTICE '          signed $% | clawback $%',
    v_body->>'api_signed_total', v_body->>'api_clawback_total';
  RAISE NOTICE '   STORED rows % | signed $% | clawback $%',
    v_body->>'stored_rows', v_body->>'stored_signed_total', v_body->>'stored_clawback_total';
END
$p$;
