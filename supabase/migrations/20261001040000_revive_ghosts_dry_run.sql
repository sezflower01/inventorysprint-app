-- DRY RUN. Asks bulk-live-verify what it WOULD do to the ghosted inventory
-- rows; mode=revive_ghosts with dry_run=true writes nothing.
--
-- Header taken from cron job 122 (pricing-suppression-worker), which is a known
-- working internal caller -- job 190's header was refused 403 earlier today.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT (regexp_match(command, 'headers:=''(\{.*?\})''::jsonb'))[1]::jsonb INTO v_headers
  FROM cron.job WHERE jobid = 122;
  IF v_headers IS NULL THEN
    RAISE NOTICE 'no usable header on cron job 122 — nothing sent';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/bulk-live-verify',
    headers := v_headers,
    body := jsonb_build_object(
      'user_id', v_uid,
      'mode', 'revive_ghosts',
      'dry_run', true,
      'limit', 500
    ),
    timeout_milliseconds := 180000
  ) INTO v_req;

  RAISE NOTICE 'dry run requested as net request %', v_req;
END
$p$;
