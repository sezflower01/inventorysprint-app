-- Run the token-cache benchmark and keep the result where it can be read.

DO $p$
DECLARE v_headers jsonb; v_req bigint;
BEGIN
  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/lwa-cache-bench',
    headers := v_headers,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;

  RAISE NOTICE 'benchmark fired as net request % (read it next)', v_req;
END
$p$;
