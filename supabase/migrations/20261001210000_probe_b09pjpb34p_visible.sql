-- READ-ONLY PROBE. Is the listing visible to the repricer now?

DO $p$
DECLARE v_uid uuid; r record; v_body jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 170657;
  RAISE NOTICE 'apply response: %', COALESCE(v_body->'summary', 'null'::jsonb);

  FOR r IN SELECT i.sku, i.listing_status, i.available, i.reserved, i.cost, i.amount,
                  i.ghosted_at, i.source, i.updated_at,
                  a.is_enabled, a.min_price_override, a.max_price_override,
                  (upper(COALESCE(i.listing_status, '')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')) AS visible
           FROM public.inventory i
           LEFT JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin AND a.marketplace = 'US'
           WHERE i.user_id = v_uid AND i.asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  % | % | avail % reserved % | cost %/% | ghost % | source %',
      r.sku, r.listing_status, r.available, r.reserved, r.cost, r.amount, r.ghosted_at, r.source;
    RAISE NOTICE '      enabled % | bounds %/% | VISIBLE IN REPRICER: %',
      r.is_enabled, r.min_price_override, r.max_price_override, r.visible;
    RAISE NOTICE '      updated %', r.updated_at;
  END LOOP;
END
$p$;
