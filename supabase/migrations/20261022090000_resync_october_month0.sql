-- Drive the chained month fetch. The first call only returns a progressId and
-- "Syncing one month at a time..."; the actual Amazon fetch happens on a
-- follow-up call carrying continueFromMonth, which the UI normally drives.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fetch-profit-loss',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid,
      'startDate', '2026-10-01',
      'endDate', '2026-10-22',
      'forceRefresh', true,
      'continueFromMonth', 0
    ),
    timeout_milliseconds := 120000
  ) INTO v_req;

  RAISE NOTICE '== month-0 fetch triggered, request % ==', v_req;
END
$p$;
