-- READ-ONLY PROBE (defensive: the previous version cast content::jsonb
-- unconditionally and the reply was not JSON, which failed the migration and
-- blocked the queue -- the same trap as 20261001260000).
--
-- Did the revive stick, and is the listing visible to the repricer? The
-- repricer table drops a row whose inventory.listing_status is NOT_IN_CATALOG,
-- DELETED, INACTIVE, INCOMPLETE or SUPPRESSED.

DO $p$
DECLARE v_uid uuid; r record; v_status int; v_raw text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT status_code, content INTO v_status, v_raw
  FROM net._http_response WHERE id = 180651;

  IF v_status IS NULL THEN
    RAISE NOTICE 'revive reply: not recorded yet';
  ELSE
    RAISE NOTICE 'revive reply: http % | %', v_status, left(COALESCE(v_raw, '(empty)'), 400);
  END IF;

  RAISE NOTICE '';
  FOR r IN SELECT i.sku, i.listing_status, i.available, i.reserved, i.cost,
                  i.ghosted_at, i.source, i.updated_at, a.is_enabled,
                  a.min_price_override, a.max_price_override,
                  (upper(COALESCE(i.listing_status, '')) NOT IN
                    ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')) AS visible
           FROM public.inventory i
           LEFT JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin AND a.marketplace = 'US'
           WHERE i.user_id = v_uid AND i.asin = 'B09PJPB34P' LOOP
    RAISE NOTICE 'B09PJPB34P | % | % | stock %/% | cost % | ghost % | source %',
      r.sku, r.listing_status, r.available, r.reserved, r.cost, r.ghosted_at, r.source;
    RAISE NOTICE '  enabled % | bounds %/% | VISIBLE IN REPRICER: % | updated %',
      r.is_enabled, r.min_price_override, r.max_price_override, r.visible, r.updated_at;
  END LOOP;
END
$p$;
