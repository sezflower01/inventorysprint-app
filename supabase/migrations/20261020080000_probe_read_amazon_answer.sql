-- READ-ONLY. Read request 61477's response: Amazon's own FBA summaries for
-- B00LFXMBKI, plus confirmation that the call declined to write.
DO $p$
DECLARE v_uid uuid; r record; v_body jsonb; v_status int; j jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 61477;

  IF v_body IS NULL THEN
    RAISE NOTICE 'no response yet for 61477 (status %)', COALESCE(v_status::text,'-');
    FOR r IN SELECT id, status_code, left(COALESCE(content,error_msg,''),300) AS c
             FROM net._http_response ORDER BY id DESC LIMIT 3
    LOOP RAISE NOTICE '   recent: % | % | %', r.id, r.status_code, r.c; END LOOP;
    RETURN;
  END IF;

  RAISE NOTICE '== HTTP % ==', v_status;
  RAISE NOTICE '';
  RAISE NOTICE '== DID IT WRITE? ==';
  RAISE NOTICE '   skipped_update_reason : %', COALESCE(v_body->>'skipped_update_reason','(null = it wrote)');
  RAISE NOTICE '   updated_db            : %', COALESCE(v_body->'updated_db')::text;
  RAISE NOTICE '   had_existing_record   : %', v_body->>'had_existing_record';
  RAISE NOTICE '';
  RAISE NOTICE '== WHAT DOES AMAZON SAY? ==';
  RAISE NOTICE '   marketplace_succeeded    : %', COALESCE(v_body->>'marketplace_succeeded','-');
  RAISE NOTICE '   raw_summaries_count      : %', COALESCE(v_body->>'raw_summaries_count','-');
  RAISE NOTICE '   matched_summaries_count  : %', COALESCE(v_body->>'matched_summaries_count','-');
  RAISE NOTICE '   exact_seller_sku_match   : %', COALESCE(v_body->>'exact_seller_sku_match','-');
  RAISE NOTICE '   matched_summary_identity : %', COALESCE(v_body->'matched_summary_identity')::text;
  RAISE NOTICE '   live_stock               : %', COALESCE(v_body->'live_stock')::text;
  RAISE NOTICE '   raw_quantities           : %', COALESCE(v_body->'raw_quantities')::text;
  RAISE NOTICE '   inbound_components       : %', COALESCE(v_body->'inbound_components')::text;
  RAISE NOTICE '   suspicious_zero_blocked  : %', v_body->>'suspicious_zero_blocked';
  RAISE NOTICE '   verification_status      : %', COALESCE(v_body->'verification_status')::text;
  RAISE NOTICE '';
  RAISE NOTICE '== THE DECIDING FIELD: which seller SKU did Amazon report? ==';
  FOR r IN
    SELECT left(COALESCE(v_body->>'raw_summary_excerpt', '(none)'), 1800) AS x
  LOOP RAISE NOTICE '   %', r.x; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and has the worker started recording skips yet? ==';
  FOR r IN
    SELECT status, count(*) AS rows, max(processed_at) AS latest,
           max(last_error) AS sample_reason
    FROM public.inventory_refresh_queue WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | latest % | %',
      rpad(r.status,9), lpad(r.rows::text,7), r.latest, COALESCE(r.sample_reason,'-');
  END LOOP;
END
$p$;
