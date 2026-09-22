-- Queue ONE buyable-state re-check for B09N1RG7JC (US, SKU 1067509411).
--
-- The direct call (20260922011000) was refused at the gateway:
-- check-pricing-suppression-item keeps verify_jwt = true and the vault holds
-- no service-role key, so an x-internal-secret-only call gets
-- UNAUTHORIZED_NO_AUTH_HEADER before the function runs. The supported path is
-- the queue: pricing-suppression-worker (cron #122, every minute) drains
-- pricing_suppression_check_queue and makes that call with the right
-- credentials. This is the same row the nightly enqueue writes, at priority 1
-- so it goes ahead of anything else waiting.

INSERT INTO public.pricing_suppression_check_queue (user_id, asin, sku, marketplace, status, priority)
SELECT u.id, 'B09N1RG7JC', '1067509411', 'US', 'pending', 1
FROM auth.users u
WHERE u.email = 'sezflower01@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.pricing_suppression_check_queue q
    WHERE q.user_id = u.id AND q.sku = '1067509411' AND q.marketplace = 'US'
      AND q.status IN ('pending','running'));
