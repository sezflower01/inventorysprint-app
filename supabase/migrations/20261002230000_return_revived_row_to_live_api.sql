-- Hand B09PJPB34P back to the normal inventory syncs.
--
-- The revive had to write source = 'force_relist' to get past
-- fn_protect_ghost_tombstone, and the row kept that value. It is not cosmetic:
-- fn_inventory_freshness_guard lets 'force_relist' BYPASS the stale-write
-- watermark, so a late or out-of-order sync could overwrite the stock without
-- being blocked. The code path is fixed (bulk-live-verify now always restores
-- 'live_api' on a revive); this repairs the one row already written.
--
-- Safe: listing_status is already ACTIVE, so the tombstone guard does not fire
-- on this update, and nothing else about the row changes.

UPDATE public.inventory
SET source = 'live_api'
WHERE asin = 'B09PJPB34P'
  AND source = 'force_relist'
  AND upper(COALESCE(listing_status, '')) NOT IN ('NOT_IN_CATALOG', 'DELETED');

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT sku, listing_status, source, available, ghosted_at
           FROM public.inventory WHERE asin = 'B09PJPB34P' LOOP
    RAISE NOTICE 'B09PJPB34P | % | % | source % | stock % | ghost %',
      r.sku, r.listing_status, r.source, r.available, r.ghosted_at;
  END LOOP;
END
$p$;
