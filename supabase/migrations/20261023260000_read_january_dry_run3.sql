DO $p$
DECLARE v_body jsonb; v_status int; r record;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 37863;
  IF v_body IS NULL THEN RAISE NOTICE '== 37863: pending (or stalled) =='; RETURN; END IF;
  RAISE NOTICE '== HTTP % | wrote: % | dry_run: % ==',
    v_status, v_body->>'wrote', COALESCE(v_body->>'dry_run','-');
  IF v_body ? 'error' THEN RAISE NOTICE '   ERROR: %', v_body->>'error'; RETURN; END IF;
  IF v_body ? 'aborted' THEN RAISE NOTICE '   ABORTED: %', v_body->>'aborted'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   window        % .. %',
    left(v_body->'window'->>'posted_after',19), left(v_body->'window'->>'posted_before',19);
  RAISE NOTICE '   pages % | rate limits % | elapsed % ms',
    v_body->>'pages', v_body->>'rate_limit_hits', v_body->>'elapsed_ms';
  RAISE NOTICE '';
  RAISE NOTICE '   API  items % -> % rows after dedupe (% routed to nothing)',
    v_body->>'api_items', v_body->>'api_rows_after_dedupe', v_body->>'api_items_routed_to_nothing';
  RAISE NOTICE '   API  signed total $% | clawback $%',
    v_body->>'api_signed_total', v_body->>'api_clawback_total';
  RAISE NOTICE '   STORED rows %', v_body->>'stored_rows';
  RAISE NOTICE '   STORED signed total $% | clawback $%',
    v_body->>'stored_signed_total', v_body->>'stored_clawback_total';
END
$p$;
