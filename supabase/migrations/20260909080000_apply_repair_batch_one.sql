-- LIVE RUN, first batch. dry_run false.
--
-- Every value written here was read back from Amazon GetOrderItems for that
-- exact order; the fee-ratio shortlist only chose which orders to ask about.
-- The preceding dry run proposed exactly three changes:
--
--   111-8310672-6833058  qty 1->3, revenue 7.89->23.67, cost 8.70->8.71
--                        (two order items confirmed by Amazon)
--   112-4585652-6745824  qty 1->2, cost 8.10->16.20
--                        (two order items confirmed by Amazon)
--   111-0457401-1966628  qty 1->5, cost 8.00->40.00
--
-- Note the direction: two of the three RAISE cost of goods and therefore LOWER
-- reported profit. That is the class B correction and it is the honest one.

DO $run$
DECLARE v_uid uuid; v_secret text; v_req_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', v_uid, 'marketplace', 'US', 'dry_run', false, 'limit', 12
    ),
    timeout_milliseconds := 150000
  ) INTO v_req_id;

  RAISE NOTICE 'LIVE repair batch dispatched, request id %', v_req_id;
END
$run$;
