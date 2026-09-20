-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller says B00FAIUBKG is a DELETED listing (Amazon restricted it), so the
-- "6 available + 46 reserved + 61 inbound" our records show is not real stock.
-- Two questions:
--   1. What do we still hold for that ASIN, and does anything mark it
--      restricted or deleted?
--   2. How much other stock in inventory is the same shape -- a SKU Amazon no
--      longer lists (NOT_IN_CATALOG) whose row stopped syncing weeks ago --
--      since every "in stock" count on the app believes those units exist.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== B00FAIUBKG: every inventory row ==';
  FOR r IN SELECT sku, available, reserved, inbound, units, listing_status, fba_blocked, fba_block_reason,
                  ghosted_at, ghost_reason, deleted_by, deleted_reason,
                  to_char(last_inventory_sync_at, 'YYYY-MM-DD HH24:MI') AS sync, to_char(updated_at, 'YYYY-MM-DD') AS upd
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B00FAIUBKG' ORDER BY sku LOOP
    RAISE NOTICE '  % | avail % res % inb % units % | % | fba_blocked % % | ghosted % % | deleted % % | synced % | updated %',
      r.sku, r.available, r.reserved, r.inbound, r.units, r.listing_status, r.fba_blocked, r.fba_block_reason,
      r.ghosted_at, r.ghost_reason, r.deleted_by, r.deleted_reason, r.sync, r.upd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B00FAIUBKG: repricer assignments ==';
  FOR r IN SELECT sku, marketplace, status, is_enabled, is_restricted, is_listing_inactive_not_buyable,
                  last_disabled_reason, to_char(updated_at, 'YYYY-MM-DD') AS upd
           FROM public.repricer_assignments WHERE user_id = v_uid AND asin = 'B00FAIUBKG' ORDER BY marketplace, sku LOOP
    RAISE NOTICE '  %/% | % enabled=% | restricted % | inactive % | % | %', r.marketplace, r.sku, r.status, r.is_enabled,
      r.is_restricted, r.is_listing_inactive_not_buyable, COALESCE(r.last_disabled_reason, '-'), r.upd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how widespread is stale "stock" that Amazon no longer lists? ==';
  FOR r IN SELECT listing_status,
                  count(*) AS skus,
                  sum(COALESCE(available,0)) AS available_units,
                  sum(COALESCE(reserved,0) + COALESCE(inbound,0)) AS other_units,
                  count(*) FILTER (WHERE last_inventory_sync_at < now() - interval '14 days') AS not_synced_14d,
                  sum(COALESCE(available,0)) FILTER (WHERE last_inventory_sync_at < now() - interval '14 days') AS stale_available
           FROM public.inventory
           WHERE user_id = v_uid AND (COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(inbound,0)) > 0
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % : % SKUs, % available + % reserved/inbound | not synced in 14d: % SKUs holding % available',
      COALESCE(r.listing_status, '(null)'), r.skus, r.available_units, r.other_units, r.not_synced_14d, r.stale_available;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the worst stale rows (NOT_IN_CATALOG, still counted as stock) ==';
  FOR r IN SELECT asin, sku, available, reserved, inbound, to_char(last_inventory_sync_at, 'YYYY-MM-DD') AS sync, left(title, 45) AS title
           FROM public.inventory
           WHERE user_id = v_uid AND listing_status = 'NOT_IN_CATALOG'
             AND (COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(inbound,0)) > 0
           ORDER BY (COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(inbound,0)) DESC LIMIT 10 LOOP
    RAISE NOTICE '  % % | avail % res % inb % | synced % | %', r.asin, r.sku, r.available, r.reserved, r.inbound, r.sync, r.title;
  END LOOP;
END
$p$;
