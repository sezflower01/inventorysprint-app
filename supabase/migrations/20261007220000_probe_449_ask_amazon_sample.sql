-- READ-ONLY PROBE. Ask Amazon what it says about a sample of the 449.
--
-- Stratified rather than top-by-value, because the point is the DISTRIBUTION:
-- 10 that we call Pending, 10 we already call Canceled, 10 we call Shipped.
-- Taking the 30 biggest would have told us about the tail and nothing about
-- the shape.
--
-- probe-order-status-sample has no write path. Nothing here changes a row.

DO $p$
DECLARE
  v_uid uuid; v_secret text; v_ids jsonb; v_req bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN RAISE NOTICE 'no INTERNAL_SYNC_SECRET in vault'; RETURN; END IF;

  WITH cohort AS (
    SELECT order_id, COALESCE(order_status, '(null)') AS st,
           row_number() OVER (PARTITION BY COALESCE(order_status, '(null)')
                              ORDER BY estimated_price * quantity DESC) AS rn
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price, 0) = 0 AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date <= current_date - 90
  )
  SELECT jsonb_agg(order_id) INTO v_ids FROM cohort WHERE rn <= 10;

  RAISE NOTICE 'asking Amazon about % orders', jsonb_array_length(v_ids);

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-order-status-sample',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object('order_ids', v_ids, 'user_email', 'sezflower01@gmail.com'),
    timeout_milliseconds := 120000
  ) INTO v_req;

  RAISE NOTICE 'request id % dispatched -- read the reply with the follow-up probe', v_req;
  INSERT INTO public.cron_run_history (job_name, status, started_at, detail)
  VALUES ('probe-449-ask-amazon', 'dispatched', now(), jsonb_build_object('request_id', v_req));
END
$p$;
