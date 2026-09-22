-- Re-check ONE listing's buyable state now instead of waiting for the nightly
-- scan. B09N1RG7JC (US, SKU 1067509411) was flagged "inactive, not buyable"
-- at 2026-09-22 08:39 after Amazon deactivated it pending receipts; the
-- seller has since been approved and reactivated it.
--
-- is_listing_inactive_not_buyable makes repricer-unified-dispatch skip the
-- listing entirely, and the only thing that clears it is
-- pricing-suppression-core, reached via a queue filled once a day at 08:30
-- UTC. So without this call the listing would sit out of the repricer until
-- tomorrow morning.
--
-- check-pricing-suppression-item reads the listing from Amazon and sets the
-- flag to whatever Amazon says -- the same call the nightly worker makes, for
-- one item.

DO $p$
DECLARE v_uid uuid; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-pricing-suppression-item',
    headers := (SELECT jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', decrypted_secret::text)
                FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1),
    body := jsonb_build_object('user_id', v_uid, 'sku', '1067509411', 'marketplace', 'US'),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE 'request %', v_req;
END
$p$;
