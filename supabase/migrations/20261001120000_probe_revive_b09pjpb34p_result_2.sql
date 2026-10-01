-- READ-ONLY PROBE, retry. The snapshot paging makes the call take ~40 s, so the
-- first read was too early.

DO $p$
DECLARE r record; v_body jsonb; v_status int;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 170475;

  IF v_status IS NULL THEN
    RAISE NOTICE 'STILL no response for request 170475';
    RETURN;
  END IF;

  RAISE NOTICE 'http % | summary %', v_status, v_body->'summary';
  IF v_status <> 200 THEN
    RAISE NOTICE 'body: %', left(COALESCE(v_body::text, ''), 500);
  END IF;
  FOR r IN SELECT e->>'action' AS action, e->>'sku' AS sku, e->>'live_sku' AS live_sku,
                  e->>'detail' AS detail, e->>'stage' AS stage
           FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e LOOP
    RAISE NOTICE '  % (%) | our sku % | live sku % | %',
      r.action, r.stage, r.sku, COALESCE(r.live_sku, '<same>'), COALESCE(r.detail, '');
  END LOOP;
END
$p$;
