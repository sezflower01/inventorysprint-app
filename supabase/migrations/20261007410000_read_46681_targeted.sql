DO $p$
DECLARE v jsonb; r record; n int := 0;
BEGIN
  FOR r IN SELECT id, status_code, created, left(COALESCE(content,''),120) AS body
           FROM net._http_response WHERE id BETWEEN 46670 AND 46700 ORDER BY id LOOP
    RAISE NOTICE '  % | http % | % | %', r.id, r.status_code, r.created, r.body;
  END LOOP;

  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46681;
  IF v IS NULL THEN RAISE NOTICE '(46681 absent)'; RETURN; END IF;
  RAISE NOTICE '';
  RAISE NOTICE 'apply=% ordersAsked=% tally=%', v->>'apply', v->>'ordersAsked', v->'tally';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
    n := n + 1;
    RAISE NOTICE '  % | % | % -> % | %',
      rpad(COALESCE(r.c->>'order_id','-'), 21), COALESCE(r.c->>'asin','-'),
      rpad(COALESCE(r.c->'was'->>'status','-'), 9),
      rpad(COALESCE(r.c->'now'->>'status', r.c->>'amazon_status', r.c->>'action','-'), 9),
      CASE WHEN COALESCE(r.c->'now'->>'sold_price','null') = 'null'
           THEN 'no price read' ELSE '$' || (r.c->'now'->>'sold_price') END;
  END LOOP;
  RAISE NOTICE '  (% rows)', n;
END
$p$;
