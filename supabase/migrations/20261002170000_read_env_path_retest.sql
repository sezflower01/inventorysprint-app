-- READ-ONLY PROBE. The env-credential path, re-tested with a real SP-API call
-- after the switch back to app 15f6. This is the half the repricer does not
-- exercise: ~73 functions (orders, inventory, labels, settlements, P&L, both
-- extensions) read LWA_CLIENT_SECRET from the Supabase dashboard rather than
-- the stored row.

DO $p$
DECLARE v_body jsonb; v_status int;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 180545;

  IF v_status IS NULL THEN
    RAISE NOTICE 'no reply yet for request 180545';
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
