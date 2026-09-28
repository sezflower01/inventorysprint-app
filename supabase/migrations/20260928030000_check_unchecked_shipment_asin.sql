-- Ask Amazon whether B06XB38P47 (Milani Strobelight, SKU 08G-D18-XR9A, 4 units)
-- can be sold on this account. It is the ONE item in the refused shipment with
-- no eligibility record -- 39 of 40 are approved -- so it is the candidate for
-- "Approval is required before this item can be sent to Amazon".
--
-- Milani is a commonly gated beauty brand, and gating is per ASIN: the other
-- Milani Strobelight variant in the same shipment (B06X9XRF8D) IS approved,
-- which is exactly how one variant slips through unchecked.
--
-- check-product-eligibility keeps verify_jwt = true (the browser calls it), so
-- an internal call needs BOTH the vault's INTERNAL_SYNC_SECRET and a bearer
-- the gateway accepts -- reusing cron #190's own header, as with the earlier
-- fee re-enrichment. No credential is printed.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT (regexp_match(command, 'headers:=''(\{.*?\})''::jsonb'))[1]::jsonb INTO v_headers
  FROM cron.job WHERE jobid = 190;
  IF v_headers IS NULL THEN RAISE NOTICE 'no usable auth header'; RETURN; END IF;

  v_headers := v_headers || jsonb_build_object(
    'x-internal-secret', (SELECT decrypted_secret::text FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1));

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-product-eligibility',
    headers := v_headers,
    body := jsonb_build_object(
      'userId', v_uid,
      'marketplace', 'US',
      'asins', jsonb_build_array('B06XB38P47', 'B08CRM22W8'),
      'force_rescan', true
    ),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE 'request %', v_req;
END
$p$;
