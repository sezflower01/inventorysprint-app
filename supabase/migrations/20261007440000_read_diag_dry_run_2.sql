DO $p$
DECLARE v jsonb; r record;
BEGIN
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46704;
  IF v IS NULL THEN RAISE NOTICE '(46704 not back yet)'; RETURN; END IF;
  IF v ? 'error' THEN RAISE NOTICE 'ERROR: %', v->>'error'; RETURN; END IF;
  RAISE NOTICE 'tally: %', v->'tally';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
    RAISE NOTICE '  % | our asin % | amazon says % | items returned % | with price % | their asins %',
      rpad(COALESCE(r.c->>'order_id','-'), 21),
      rpad(COALESCE(r.c->>'asin','-'), 11),
      rpad(COALESCE(r.c->'now'->>'status', r.c->>'action','-'), 9),
      COALESCE(r.c->>'items_returned','-'),
      COALESCE(r.c->>'items_with_price','-'),
      COALESCE(r.c->>'item_asins','-');
  END LOOP;
END
$p$;
