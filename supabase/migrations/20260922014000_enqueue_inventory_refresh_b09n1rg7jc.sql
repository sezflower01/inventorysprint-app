-- Queue ONE inventory refresh for B09N1RG7JC (US, SKU 1067509411).
--
-- Clearing is_listing_inactive_not_buyable (20260922012000) was not enough:
-- repricer-unified-dispatch ALSO skips any SKU whose inventory.listing_status
-- is INACTIVE / NOT_FOUND / INCOMPLETE (the isInactive check in the scoring
-- loop). This row still reads INACTIVE from the 12:45 sync, taken before
-- Amazon's reactivation propagated, and the next full refresh is not until
-- 15:15 UTC. inventory-refresh-worker (cron #115, every minute) drains this
-- queue; priority 1 puts it ahead of the backlog.

INSERT INTO public.inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
SELECT u.id, 'B09N1RG7JC', '1067509411', 'US', 'pending', 1
FROM auth.users u
WHERE u.email = 'sezflower01@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_refresh_queue q
    WHERE q.user_id = u.id AND q.asin = 'B09N1RG7JC' AND q.sku = '1067509411' AND q.marketplace = 'US'
      AND q.status IN ('pending','running'));
