-- READ-ONLY PROBE. Amazon's exact answer to the env-path refresh-token grant.
--
-- This matters because the curl that succeeded used the CLIENT_CREDENTIALS
-- grant, which validates the client_id + client_secret pair on its own. The
-- call that keeps failing is the REFRESH_TOKEN grant, which additionally
-- requires that the refresh token was issued to that same client. So a valid
-- pair plus invalid_client points at a mismatch between the app the secret
-- belongs to and the app the stored client_id / refresh token belong to.

DO $p$
DECLARE v_body jsonb; v_status int;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 179923;

  IF v_status IS NULL THEN
    RAISE NOTICE 'no reply yet for request 179923';
    RETURN;
  END IF;

  RAISE NOTICE 'http % | live SKUs: %', v_status, COALESCE(v_body->>'live_skus_seen', '(none)');
  IF v_body ? 'error' THEN
    RAISE NOTICE 'amazon/env said: %', left(v_body->>'error', 400);
  END IF;
END
$p$;
