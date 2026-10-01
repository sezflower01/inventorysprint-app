-- READ-ONLY PROBE, retry. The FBA snapshot takes a while to page through, so
-- the response had not landed yet. Reads the newest bulk-live-verify response
-- instead of a fixed request id.

DO $p$
DECLARE r record; v_body jsonb; v_status int; v_id bigint; v_created timestamptz;
BEGIN
  SELECT res.id, res.status_code, res.created, res.content::jsonb
    INTO v_id, v_status, v_created, v_body
  FROM net._http_response res
  JOIN net.http_request_queue q ON q.id = res.id
  WHERE q.url LIKE '%bulk-live-verify%'
  ORDER BY res.created DESC LIMIT 1;

  IF v_status IS NULL THEN
    -- the queue row is deleted once delivered, so fall back to the id we know
    SELECT id, status_code, created, content::jsonb INTO v_id, v_status, v_created, v_body
    FROM net._http_response WHERE id = 170385;
  END IF;

  IF v_status IS NULL THEN
    RAISE NOTICE 'still no response recorded';
    RETURN;
  END IF;

  RAISE NOTICE 'request % | http % | % | live SKUs: %', v_id, v_status, v_created, v_body->>'live_skus_seen';
  RAISE NOTICE 'summary: %', v_body->'summary';

  RAISE NOTICE '';
  RAISE NOTICE '== B09PJPB34P ==';
  FOR r IN SELECT e->>'action' AS action, e->>'sku' AS sku, e->>'live_sku' AS live_sku, e->>'detail' AS detail
           FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e
           WHERE e->>'asin' = 'B09PJPB34P' LOOP
    RAISE NOTICE '  action % | our sku % | live sku % | %', r.action, r.sku, COALESCE(r.live_sku, '<same>'), r.detail;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== everything it would act on ==';
  FOR r IN SELECT e->>'asin' AS asin, e->>'sku' AS sku, e->>'action' AS action,
                  e->>'live_sku' AS live_sku, e->>'detail' AS detail
           FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e
           WHERE e->>'action' IN ('revived_same_sku', 'remapped_to_live_sku', 'merged_into_live_sku', 'live_but_empty', 'ambiguous_multiple_live_skus')
           ORDER BY 3, 1 LIMIT 60 LOOP
    RAISE NOTICE '  % | % -> % | % | %', r.action, r.sku, COALESCE(r.live_sku, r.sku), r.asin, r.detail;
  END LOOP;
END
$p$;
