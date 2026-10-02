-- READ-ONLY PROBE, retry. The FBA snapshot takes ~40 s to page through, so the
-- first read was early.

DO $p$
DECLARE v_body jsonb; v_status int;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 180545;

  IF v_status IS NULL THEN
    RAISE NOTICE 'STILL no reply for request 180545';
    RETURN;
  END IF;

  RAISE NOTICE 'http % | live SKUs seen from Amazon: %',
    v_status, COALESCE(v_body->>'live_skus_seen', '(none)');
  IF v_body ? 'error' THEN
    RAISE NOTICE 'error: %', left(v_body->>'error', 300);
  END IF;
  IF COALESCE((v_body->>'live_skus_seen')::int, 0) > 0 THEN
    RAISE NOTICE 'VERDICT: env path WORKS — a real FBA inventory call returned live data';
  ELSE
    RAISE NOTICE 'VERDICT: env path still not returning live data';
  END IF;
END
$p$;
