-- READ-ONLY PROBE, retry.

DO $p$
DECLARE v_uid uuid; r record; v_status int; v_raw text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT status_code, content INTO v_status, v_raw
  FROM net._http_response WHERE id = 180651;
  RAISE NOTICE 'revive reply: http % | %',
    COALESCE(v_status::text, 'pending'), left(COALESCE(v_raw, '(none)'), 500);

  RAISE NOTICE '';
  FOR r IN SELECT i.sku, i.listing_status, i.available, i.reserved, i.cost,
                  i.ghosted_at, i.source, i.updated_at, a.is_enabled,
                  (upper(COALESCE(i.listing_status, '')) NOT IN
                    ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')) AS visible
           FROM public.inventory i
           LEFT JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin AND a.marketplace = 'US'
           WHERE i.user_id = v_uid AND i.asin = 'B09PJPB34P' LOOP
    RAISE NOTICE 'B09PJPB34P | % | % | stock %/% | cost % | ghost % | source % | enabled % | VISIBLE: % | updated %',
      r.sku, r.listing_status, r.available, r.reserved, r.cost, r.ghosted_at,
      r.source, r.is_enabled, r.visible, r.updated_at;
  END LOOP;
END
$p$;
