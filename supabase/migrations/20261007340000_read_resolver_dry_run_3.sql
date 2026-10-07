DO $p$
DECLARE v jsonb; r record; n int := 0;
BEGIN
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46646;
  IF v IS NULL THEN
    FOR r IN SELECT id, status_code, created, left(COALESCE(error_msg,''),80) AS e
             FROM net._http_response ORDER BY id DESC LIMIT 5 LOOP
      RAISE NOTICE '  recent reply % | http % | % | %', r.id, r.status_code, r.created, r.e;
    END LOOP;
    RAISE NOTICE '(46646 still absent)';
    RETURN;
  END IF;
  IF v ? 'error' THEN RAISE NOTICE 'ERROR: %', v->>'error'; RETURN; END IF;

  RAISE NOTICE 'apply=% ordersAsked=% rowsConsidered=%',
    v->>'apply', v->>'ordersAsked', v->>'rowsConsidered';
  RAISE NOTICE 'tally: %', v->'tally';
  RAISE NOTICE '';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
    n := n + 1;
    IF n <= 20 THEN
      RAISE NOTICE '  % | % | we said % -> amazon says % | would write sold %',
        COALESCE(r.c->>'order_id','-'), COALESCE(r.c->>'asin','-'),
        rpad(COALESCE(r.c->'was'->>'status', '-'), 9),
        rpad(COALESCE(r.c->'now'->>'status', r.c->>'amazon_status', r.c->>'action', '-'), 9),
        COALESCE(r.c->'now'->>'sold_price','(none)');
    END IF;
  END LOOP;
  RAISE NOTICE '  (% rows in the change list)', n;
END
$p$;
