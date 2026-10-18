-- Re-invoke the fee backfill with a wider budget.
--
-- The first run succeeded (HTTP 200, selected_asins 5, cached_written 5,
-- orders_updated 15) but did not reach B07KY25WY7/CA: the function pulls up to
-- 500 candidate orders, dedupes them into a Map, then takes only max_asins of
-- them -- and the query has no ORDER BY, so which ones it takes is arbitrary.
-- Asking for 5 and hoping the one ASIN we care about is among them was
-- optimistic.
--
-- 60 is chosen to comfortably exceed the candidate count rather than to be a
-- round number. This spends Amazon Fees API calls, which are a DIFFERENT
-- operation from the getItemOffers quota the repricer depends on, so it does
-- not compete with repricing.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(DISTINCT so.asin || '|' || COALESCE(so.marketplace,'US')) INTO n
  FROM public.sales_orders so
  WHERE so.user_id = v_uid
    AND (so.fees_missing = true OR so.fees_source IS NULL OR so.fees_source = 'unavailable')
    AND so.asin IS NOT NULL AND so.asin NOT IN ('UNKNOWN','PENDING');
  RAISE NOTICE '== candidate ASIN+marketplace pairs needing fees: % ==', n;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE NOTICE '== no vault secret -- cannot invoke ==';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-fee-cache',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', v_uid::text,
      'max_asins', 60
    ),
    timeout_milliseconds := 120000
  ) INTO v_req;

  RAISE NOTICE '== invoked with max_asins 60, pg_net request id % ==', v_req;
END
$p$;
