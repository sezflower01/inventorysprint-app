DO $p$
DECLARE v jsonb; r record;
BEGIN
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46646;
  IF v IS NULL THEN RAISE NOTICE '(no reply yet for 46646)'; RETURN; END IF;
  IF v ? 'error' THEN RAISE NOTICE 'ERROR: %', v->>'error'; RETURN; END IF;

  RAISE NOTICE 'apply=% ordersAsked=% rowsConsidered=%',
    v->>'apply', v->>'ordersAsked', v->>'rowsConsidered';
  RAISE NOTICE 'tally: %', v->'tally';
  RAISE NOTICE '';
  RAISE NOTICE 'order | asin | was -> now | priced';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
    RAISE NOTICE '  % | % | % -> % | sold % | priced %',
      COALESCE(r.c->>'order_id','-'),
      COALESCE(r.c->>'asin','-'),
      rpad(COALESCE(r.c->'was'->>'status', r.c->>'action', '-'), 10),
      rpad(COALESCE(r.c->'now'->>'status', r.c->>'amazon_status', '-'), 10),
      COALESCE(r.c->'now'->>'sold_price','-'),
      COALESCE(r.c->>'priced','-');
  END LOOP;
END
$p$;
