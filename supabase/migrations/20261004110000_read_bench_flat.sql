-- READ-ONLY PROBE. The benchmark body, newlines flattened -- a multi-line
-- RAISE NOTICE only shows its first line through the migration output filter,
-- which is why the previous read appeared to print almost nothing.

DO $p$
DECLARE v_body jsonb;
BEGIN
  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 222888;
  IF v_body IS NULL THEN RAISE NOTICE 'no result'; RETURN; END IF;

  RAISE NOTICE 'exchange ms:   % | avg %', v_body->'exchange_ms', v_body->>'exchange_avg_ms';
  RAISE NOTICE 'cache hit ms:  % | avg %', v_body->'cache_hit_ms', v_body->>'cache_hit_avg_ms';
  RAISE NOTICE 'saved per exchange: % ms', v_body->>'saved_per_exchange_ms';
  RAISE NOTICE 'panel exchanges before: % -> saving % ms per load',
    v_body->>'panel_exchanges_before', v_body->>'panel_saving_ms';
  RAISE NOTICE 'errors: %', v_body->'errors';
END
$p$;
