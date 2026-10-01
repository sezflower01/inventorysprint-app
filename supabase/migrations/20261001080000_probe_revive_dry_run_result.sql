-- READ-ONLY PROBE. What did the revive_ghosts dry run say?

DO $p$
DECLARE r record; v_body jsonb; v_status int;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 170385;

  IF v_status IS NULL THEN
    RAISE NOTICE 'no response recorded yet for request 170385';
    RETURN;
  END IF;

  RAISE NOTICE 'http % | live SKUs in the FBA snapshot: %', v_status, v_body->>'live_skus_seen';
  RAISE NOTICE 'summary: %', v_body->'summary';

  RAISE NOTICE '';
  RAISE NOTICE '== what it would do, by action ==';
  FOR r IN
    SELECT e->>'action' AS action, count(*) AS n,
           string_agg(DISTINCT (e->>'asin'), ', ' ORDER BY (e->>'asin')) AS asins
    FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e
    WHERE e->>'action' <> 'still_absent'
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  % : % | %', r.action, r.n, left(r.asins, 400);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B09PJPB34P specifically ==';
  FOR r IN
    SELECT e->>'action' AS action, e->>'sku' AS sku, e->>'live_sku' AS live_sku, e->>'detail' AS detail
    FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e
    WHERE e->>'asin' = 'B09PJPB34P'
  LOOP
    RAISE NOTICE '  action % | our sku % | live sku % | %', r.action, r.sku, COALESCE(r.live_sku, '<same>'), r.detail;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the revivable ones with stock, in detail ==';
  FOR r IN
    SELECT e->>'asin' AS asin, e->>'sku' AS sku, e->>'action' AS action,
           e->>'live_sku' AS live_sku, e->>'detail' AS detail
    FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e
    WHERE e->>'action' IN ('revived_same_sku', 'remapped_to_live_sku', 'merged_into_live_sku')
    ORDER BY 1 LIMIT 40
  LOOP
    RAISE NOTICE '  % | % -> % | % | %', r.asin, r.sku, COALESCE(r.live_sku, r.sku), r.action, r.detail;
  END LOOP;
END
$p$;
