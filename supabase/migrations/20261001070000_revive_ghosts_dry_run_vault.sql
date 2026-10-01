-- DRY RUN. mode=revive_ghosts with dry_run=true writes nothing.
--
-- Builds the header the way every working cron job in this project does: read
-- INTERNAL_SYNC_SECRET straight out of Vault at call time. Scraping a header
-- literal out of cron.job was the wrong approach twice over -- the jobs do not
-- store one (they build it from Vault), and the one job that DID carry a
-- literal (190) held credentials a function guard refused with 403.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  IF v_headers IS NULL THEN
    RAISE NOTICE 'INTERNAL_SYNC_SECRET not in Vault — nothing sent';
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
