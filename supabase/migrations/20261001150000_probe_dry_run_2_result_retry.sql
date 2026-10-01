-- READ-ONLY PROBE, retry for dry run 2.

DO $p$
DECLARE r record; v_body jsonb; v_status int;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 170543;

  IF v_status IS NULL THEN
    RAISE NOTICE 'STILL no response for request 170543';
    RETURN;
  END IF;

  RAISE NOTICE 'http % | summary %', v_status, v_body->'summary';
  FOR r IN SELECT e->>'action' AS action, e->>'sku' AS sku, e->>'live_sku' AS live_sku,
                  e->>'detail' AS detail, e->>'stage' AS stage
           FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e LOOP
    RAISE NOTICE '  % (%) | sku % -> % | %',
      r.action, r.stage, r.sku, COALESCE(r.live_sku, r.sku), COALESCE(r.detail, '');
  END LOOP;
END
$p$;
