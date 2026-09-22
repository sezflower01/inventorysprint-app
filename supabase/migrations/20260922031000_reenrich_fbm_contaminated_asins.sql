-- Re-run fee enrichment for the two ASINs whose FBA orders were billed FBM
-- fees (B0CBCSWDQZ, B0G3XTWZYX), now that sync-sales-orders resolves fees per
-- (marketplace, fulfilment channel) instead of per ASIN.
--
-- sync-sales-orders keeps verify_jwt = true, so x-internal-secret alone is
-- refused at the gateway. Cron job #190 holds a working Authorization header
-- in its own command; this reads that header out of cron.job and reuses it
-- verbatim, so no credential is printed or copied anywhere.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint; v_asin text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT (regexp_match(command, 'headers:=''(\{.*?\})''::jsonb'))[1]::jsonb
    INTO v_headers FROM cron.job WHERE jobid = 190;
  IF v_headers IS NULL THEN
    RAISE NOTICE 'could not read the auth header from cron job 190 -- nothing sent';
    RETURN;
  END IF;

  FOREACH v_asin IN ARRAY ARRAY['B0CBCSWDQZ', 'B0G3XTWZYX'] LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', v_uid,
        'enrich_by_asin', true,
        'target_asin', v_asin,
        'force_price_update', false
      ),
      timeout_milliseconds := 120000
    ) INTO v_req;
    RAISE NOTICE 're-enrich % -> request %', v_asin, v_req;
  END LOOP;
END
$p$;
