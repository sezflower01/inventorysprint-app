-- Trigger the two deployed fixes in order, then read the result.
--
-- ORDER MATTERS and it is not obvious. fbm-quick-check must run FIRST.
--
-- D4M-1H7-45IW carries fnsku X0059AXEPP, copied from the FBA SKU on the same
-- ASIN. detectIsFba() reads an FNSKU as proof of FBA, so before the row is
-- retyped BOTH SKUs classify as FBA, land in the same channel bucket, and the
-- new (asin, channel) dedup key collapses them exactly as the old one did.
-- The dedup fix on its own does not rescue this listing.
--
-- fbm-quick-check is what breaks that: it asks the Listings Items API for
-- fulfillmentChannelCode, and on a DEFAULT/MERCHANT answer writes the real
-- quantity, sets source='amazon_sync_fbm' and clears the false FNSKU. Only
-- then does the row classify as FBM and survive the dedup.
--
-- Calls two edge functions over net.http_post; reads nothing destructive.

DO $run$
DECLARE
  v_uid uuid;
  v_url text := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/';
  v_secret text;
  v_req_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'INTERNAL_SYNC_SECRET not readable from vault -- cannot invoke.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := v_url || 'fbm-quick-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object('user_id', v_uid, 'marketplace', 'US'),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RAISE NOTICE 'fbm-quick-check dispatched, request id %', v_req_id;
  RAISE NOTICE 'It calls auto-assign-bulk itself when it finds stock.';
  RAISE NOTICE 'Read the response with the follow-up probe.';
END
$run$;
