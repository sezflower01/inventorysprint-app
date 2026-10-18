-- Fetch the CA fee row for B07KY25WY7 by NAME, now that backfill-fee-cache
-- accepts an `only` allow-list.
--
-- Two untargeted runs (max_asins 5, then 60, against 741 candidate pairs) both
-- missed it, because the candidate query has no ORDER BY and the function
-- takes an arbitrary slice. Fixing one missing fee row should not be a lottery.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE NOTICE '== no vault secret ==';
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
      'max_asins', 5,
      'only', jsonb_build_array(
        jsonb_build_object('asin', 'B07KY25WY7', 'marketplace', 'CA')
      )
    ),
    timeout_milliseconds := 60000
  ) INTO v_req;

  RAISE NOTICE '== targeted backfill invoked for B07KY25WY7/CA, request id % ==', v_req;
END
$p$;
