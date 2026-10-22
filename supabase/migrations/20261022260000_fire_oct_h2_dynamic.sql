-- Third attempt at the October second half. Both prior 400s were my date
-- arithmetic: Amazon rejects a PostedBefore in the future, and 2026-10-23 IS
-- the future -- today is 2026-10-22. fetch-profit-loss caps its own end at
-- now-3min for exactly this reason.
--
-- Uses now()-5min so the window cannot drift into the future again, and keeps
-- Oct 22 events in scope so this is comparable with the stored October rows.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_end text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  v_end := to_char((now() AT TIME ZONE 'UTC') - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
      'posted_after','2026-10-16T00:00:00Z', 'posted_before', v_end,
      'summary_only', true),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '== Oct 16 .. % -> request % ==', v_end, v_req;
END
$p$;
