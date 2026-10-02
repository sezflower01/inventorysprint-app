-- READ-ONLY PROBE, final read of the env-path SP-API call (request 180545).

DO $p$
DECLARE v_body jsonb; v_status int; v_created timestamptz;
BEGIN
  SELECT status_code, created, content::jsonb INTO v_status, v_created, v_body
  FROM net._http_response WHERE id = 180545;

  IF v_status IS NULL THEN
    RAISE NOTICE 'no reply recorded for 180545 (the call may have outlived the 180 s timeout)';
    RETURN;
  END IF;

  RAISE NOTICE 'replied % | http % | live SKUs seen from Amazon: %',
    v_created, v_status, COALESCE(v_body->>'live_skus_seen', '(none)');
  IF v_body ? 'error' THEN RAISE NOTICE 'error: %', left(v_body->>'error', 300); END IF;
  IF COALESCE((v_body->>'live_skus_seen')::int, 0) > 0 THEN
    RAISE NOTICE 'VERDICT: env path WORKS — a real FBA inventory call returned live data';
  ELSE
    RAISE NOTICE 'VERDICT: env path did not return live data';
  END IF;
END
$p$;
