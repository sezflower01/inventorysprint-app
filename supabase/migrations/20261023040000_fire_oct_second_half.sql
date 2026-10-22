-- Re-fire the second October slice. The previous attempt used
-- posted_before=2026-11-01, which is in the FUTURE, and Amazon's Finances API
-- rejects that with a 400 (fetch-profit-loss caps its own end at now-3min for
-- the same reason). Window ends at today instead.
--
-- Fired ALONE on purpose: of the batch 21165/66/67 only the first ever
-- returned, and of 21190-93 none did. pg_net appears to hold later requests in
-- a batch past their deadline, so one slice per push is the pattern that works.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
      'posted_after','2026-10-16T00:00:00Z', 'posted_before','2026-10-23T00:00:00Z',
      'summary_only', true),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '== Oct 16..23 -> request % ==', v_req;
END
$p$;
