-- READ-ONLY. Invoke the adjustment probe for 2026-10-18..22 and record the
-- pg_net request id. The probe writes nothing; it returns Amazon's raw
-- AdjustmentEventList so the SIGN and AdjustmentType can be seen before any
-- abs() is applied.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN RAISE NOTICE 'NO INTERNAL_SYNC_SECRET in vault'; RETURN; END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid,
      'posted_after', '2026-10-18T00:00:00Z',
      'posted_before', '2026-10-22T00:00:00Z'
    ),
    timeout_milliseconds := 55000
  ) INTO v_req;

  RAISE NOTICE '== probe-adjustment-events request id % ==', v_req;
END
$p$;
