-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- 1. The evaluator dry-run responses (20260916023000). The previous probe's
--    filter matched the auto-lower-min responses instead, which also list
--    these ASINs. Evaluator responses are the ones that are NOT the
--    auto-lower payload and arrived after the 13:20:29 deploy.
-- 2. The auto-lower-min new-code dry run used some unit costs under $2
--    (0.99, 1.44, ...). Confirm none of them came from COG on record: the
--    view should only ever let a sub-$2 COG through when the seller set or
--    reviewed it.

DO $p$
DECLARE r record; v_new jsonb;
BEGIN
  RAISE NOTICE '======== evaluator dry runs ========';
  FOR r IN
    SELECT created, status_code, error_msg, length(content) AS len,
           CASE WHEN content ~ '^\s*[\{\[]' THEN content::jsonb END AS j, left(content, 300) AS head
    FROM net._http_response
    WHERE created > '2026-09-16 13:20:29+00'
      AND content NOT LIKE '%"marketplaces":["US"],"considered"%'
      AND (content LIKE '%B0H4WH84HR%' OR content LIKE '%B0725P2SY3%')
    ORDER BY created DESC LIMIT 4
  LOOP
    RAISE NOTICE '---- % status=% err=% len=%', r.created, r.status_code, r.error_msg, r.len;
    IF r.j IS NULL THEN RAISE NOTICE '  non-JSON: %', r.head; CONTINUE; END IF;
    RAISE NOTICE '  success=% error=%', r.j->>'success', r.j->>'error';
    RAISE NOTICE '  asin: %', (SELECT string_agg(DISTINCT v #>> '{}', ',') FROM jsonb_path_query(r.j, 'lax $.**.asin') v);
    RAISE NOTICE '  unit_cost: % | unitCost: %',
      (SELECT string_agg(DISTINCT v::text, ',') FROM jsonb_path_query(r.j, 'lax $.**.unit_cost') v),
      (SELECT string_agg(DISTINCT v::text, ',') FROM jsonb_path_query(r.j, 'lax $.**.unitCost') v);
    RAISE NOTICE '  cost_source: % | costSource: %',
      (SELECT string_agg(DISTINCT v::text, ' | ') FROM jsonb_path_query(r.j, 'lax $.**.cost_source') v),
      (SELECT string_agg(DISTINCT v::text, ' | ') FROM jsonb_path_query(r.j, 'lax $.**.costSource') v);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== auto-lower-min new-code dry run: costs under $2 ========';
  SELECT content::jsonb INTO v_new FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content LIKE '%"cost_source"%'
  ORDER BY created DESC LIMIT 1;
  FOR r IN SELECT d->>'asin' AS asin, d->>'unit_cost' AS cost, d->>'cost_source' AS src, d->>'action' AS action, d->>'reason' AS reason,
                  c.unit_cost AS cog_in_table, c.source AS cog_src, c.needs_review
           FROM jsonb_array_elements(v_new->'detail'->'decisions') d
           LEFT JOIN auth.users u ON u.email = 'sezflower01@gmail.com'
           LEFT JOIN public.asin_cog_on_record c ON c.user_id = u.id AND c.asin = d->>'asin'
           WHERE (d->>'unit_cost')::numeric < 2
           ORDER BY 3, 1 LOOP
    RAISE NOTICE '  % cost=% via % -> %/%  (COG table: % % needs_review=%)',
      r.asin, r.cost, r.src, r.action, r.reason, r.cog_in_table, r.cog_src, r.needs_review;
  END LOOP;
END
$p$;
