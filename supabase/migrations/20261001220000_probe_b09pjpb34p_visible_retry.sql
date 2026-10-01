-- READ-ONLY PROBE, retry. The apply call takes ~40 s (it pages the FBA
-- snapshot before the single listings-API lookup).

DO $p$
DECLARE v_uid uuid; r record; v_body jsonb; v_status int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 170657;
  RAISE NOTICE 'apply http % | summary %', v_status, COALESCE(v_body->'summary', 'null'::jsonb);
  FOR r IN SELECT e->>'action' AS action, e->>'detail' AS detail, e->>'stage' AS stage
           FROM jsonb_array_elements(COALESCE(v_body->'results', '[]'::jsonb)) e LOOP
    RAISE NOTICE '  % (%) | %', r.action, r.stage, r.detail;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT i.sku, i.listing_status, i.available, i.cost, i.ghosted_at, i.source, i.updated_at,
                  a.is_enabled,
                  (upper(COALESCE(i.listing_status, '')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')) AS visible
           FROM public.inventory i
           LEFT JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin AND a.marketplace = 'US'
           WHERE i.user_id = v_uid AND i.asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  % | % | avail % | cost % | ghost % | source % | enabled % | VISIBLE: % | updated %',
      r.sku, r.listing_status, r.available, r.cost, r.ghosted_at, r.source, r.is_enabled, r.visible, r.updated_at;
  END LOOP;
END
$p$;
