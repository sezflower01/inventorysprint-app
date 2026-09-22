-- Make the FBM-contaminated orders eligible for re-enrichment, then re-enrich.
--
-- ENRICH_BY_ASIN in non-force mode only picks up orders with
--   total_fees = 0 OR fees_source IS NULL / 'unavailable' / 'estimated'
-- so the contaminated rows (total_fees 7.50, fees_source 'fees_api_fbm') were
-- skipped and request 22277/22278 changed nothing.
--
-- Force mode WOULD pick them up, but it also rewrites prices from current
-- inventory, which on months-old orders would overwrite the real sale price.
-- So instead: clear fees_source on the affected rows -- fee VALUES are left
-- alone until Amazon's Fees API returns better ones -- and let the normal
-- non-force path recompute them, now that it resolves fees per channel
-- (20260922 sync-sales-orders change).
--
-- Scope: the two ASINs measured, and only orders that are NOT seller-fulfilled.
-- MFN orders keep their FBM fees, which are correct for them.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint; v_asin text; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  WITH cleared AS (
    UPDATE public.sales_orders
    SET fees_source = NULL, needs_fee_enrich = true
    WHERE user_id = v_uid
      AND asin IN ('B0CBCSWDQZ', 'B0G3XTWZYX')
      AND fees_source = 'fees_api_fbm'
      AND COALESCE(fulfillment_channel, 'AFN') <> 'MFN'
      AND COALESCE(is_cancelled, false) = false
    RETURNING 1)
  SELECT count(*) INTO n FROM cleared;
  RAISE NOTICE 'orders marked for re-enrichment: %', n;

  SELECT (regexp_match(command, 'headers:=''(\{.*?\})''::jsonb'))[1]::jsonb
    INTO v_headers FROM cron.job WHERE jobid = 190;
  IF v_headers IS NULL THEN RAISE NOTICE 'no auth header found on cron 190 -- not calling'; RETURN; END IF;

  FOREACH v_asin IN ARRAY ARRAY['B0CBCSWDQZ', 'B0G3XTWZYX'] LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
      headers := v_headers,
      body := jsonb_build_object('user_id', v_uid, 'enrich_by_asin', true, 'target_asin', v_asin, 'force_price_update', false),
      timeout_milliseconds := 120000
    ) INTO v_req;
    RAISE NOTICE 're-enrich % -> request %', v_asin, v_req;
  END LOOP;
END
$p$;
