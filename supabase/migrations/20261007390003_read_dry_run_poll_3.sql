DO $p$
DECLARE v jsonb; r record; n int := 0;
BEGIN
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46681;
  IF v IS NULL THEN RAISE NOTICE '(46681 has not replied yet)'; RETURN; END IF;
  IF v ? 'error' THEN RAISE NOTICE 'ERROR: %', v->>'error'; RETURN; END IF;

  RAISE NOTICE 'apply=% ordersAsked=% rowsConsidered=%',
    v->>'apply', v->>'ordersAsked', v->>'rowsConsidered';
  RAISE NOTICE 'tally: %', v->'tally';
  RAISE NOTICE '';
  RAISE NOTICE 'order | asin | we said -> amazon says | price it WOULD write';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
    n := n + 1;
    RAISE NOTICE '  % | % | % -> % | %',
      rpad(COALESCE(r.c->>'order_id','-'), 21), COALESCE(r.c->>'asin','-'),
      rpad(COALESCE(r.c->'was'->>'status','-'), 9),
      rpad(COALESCE(r.c->'now'->>'status', r.c->>'amazon_status', r.c->>'action','-'), 9),
      CASE WHEN r.c->'now'->>'sold_price' IS NULL OR r.c->'now'->>'sold_price' = 'null'
           THEN 'no price read' ELSE '$' || (r.c->'now'->>'sold_price') END;
  END LOOP;
  RAISE NOTICE '  (% rows)', n;
END
$p$;
