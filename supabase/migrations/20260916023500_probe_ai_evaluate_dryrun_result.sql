-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Read the two evaluator dry-run responses and pull out the unit cost and
-- its source, wherever the response nests them.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN
    SELECT created, status_code, error_msg, length(content) AS len,
           CASE WHEN content ~ '^\s*[\{\[]' THEN content::jsonb END AS j,
           left(content, 200) AS head
    FROM net._http_response
    WHERE created > now() - interval '10 minutes'
      AND (content LIKE '%B0H4WH84HR%' OR content LIKE '%B0725P2SY3%')
    ORDER BY created DESC LIMIT 4
  LOOP
    RAISE NOTICE '---- % status=% err=% len=%', r.created, r.status_code, r.error_msg, r.len;
    IF r.j IS NULL THEN
      RAISE NOTICE '  non-JSON: %', r.head;
      CONTINUE;
    END IF;
    RAISE NOTICE '  asin(s): %', (SELECT string_agg(DISTINCT v #>> '{}', ',') FROM jsonb_path_query(r.j, 'lax $.**.asin') v);
    RAISE NOTICE '  unit_cost: %', (SELECT string_agg(DISTINCT v::text, ',') FROM jsonb_path_query(r.j, 'lax $.**.unit_cost') v);
    RAISE NOTICE '  unitCost : %', (SELECT string_agg(DISTINCT v::text, ',') FROM jsonb_path_query(r.j, 'lax $.**.unitCost') v);
    RAISE NOTICE '  cost_source: %', (SELECT string_agg(DISTINCT v::text, ' | ') FROM jsonb_path_query(r.j, 'lax $.**.cost_source') v);
    RAISE NOTICE '  costSource : %', (SELECT string_agg(DISTINCT v::text, ' | ') FROM jsonb_path_query(r.j, 'lax $.**.costSource') v);
    RAISE NOTICE '  success/error: % / %', r.j->>'success', r.j->>'error';
  END LOOP;
END
$p$;
