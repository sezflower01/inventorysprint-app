-- Run the credential audit and print it. Read-only: the function only reads
-- env vars and the encrypted row, and returns metadata (client-id last4,
-- lengths, SHA-256 prefixes) plus the result of a client_credentials test for
-- every (id, secret) pairing. No secret value is returned or logged.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/spapi-env-audit',
    headers := v_headers,
    body := jsonb_build_object('user_id', v_uid),
    timeout_milliseconds := 60000
  ) INTO v_req;

  RAISE NOTICE 'audit fired as net request %', v_req;
END
$p$;
