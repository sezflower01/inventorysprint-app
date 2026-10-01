-- READ-ONLY PROBE. Is B09PJPB34P now visible to the repricer?
--
-- The repricer table drops a row when inventory.listing_status is
-- NOT_IN_CATALOG, DELETED, INACTIVE, INCOMPLETE or SUPPRESSED
-- (AssignmentsTable.tsx), so ACTIVE with a live assignment is the pass mark.

DO $p$
DECLARE v_uid uuid; r record; v_body jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 170577;
  RAISE NOTICE 'apply response: %', COALESCE(v_body->'summary', 'null'::jsonb);

  RAISE NOTICE '';
  RAISE NOTICE '== inventory now ==';
  FOR r IN SELECT sku, listing_status, available, reserved, inbound, cost, amount,
                  ghosted_at, ghost_reason, source, last_inventory_sync_at
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  % | % | avail % reserved % inbound % | cost % amount %',
      r.sku, r.listing_status, r.available, r.reserved, r.inbound, r.cost, r.amount;
    RAISE NOTICE '      ghosted % (%) | source % | synced %',
      r.ghosted_at, COALESCE(r.ghost_reason, ''), r.source, r.last_inventory_sync_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== would the repricer table show it? ==';
  FOR r IN SELECT i.sku, i.listing_status, a.is_enabled, a.marketplace,
                  (upper(COALESCE(i.listing_status, '')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')) AS passes_filter
           FROM public.inventory i
           JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin
           WHERE i.user_id = v_uid AND i.asin = 'B09PJPB34P' AND a.marketplace = 'US' LOOP
    RAISE NOTICE '  % | % | enabled % | visible: %', r.sku, r.listing_status, r.is_enabled, r.passes_filter;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the COG it will price against ==';
  FOR r IN SELECT unit_cost, source, updated_at FROM public.asin_cog_for_repricer
           WHERE user_id = v_uid AND asin = 'B09PJPB34P' LOOP
    RAISE NOTICE '  unit cost % | source % | %', r.unit_cost, r.source, r.updated_at;
  END LOOP;
END
$p$;
