DO $p$
DECLARE r record; v jsonb;
BEGIN
  FOR r IN SELECT id, status_code, created, left(COALESCE(content,''),200) AS body
           FROM net._http_response WHERE id BETWEEN 46725 AND 46760 ORDER BY id LOOP
    IF r.body LIKE '%ordersAsked%' OR r.status_code IS NULL OR r.status_code >= 400 THEN
      RAISE NOTICE '  % | http % | % | %', r.id, r.status_code, r.created, r.body;
    END IF;
  END LOOP;

  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46727;
  IF v IS NULL THEN RAISE NOTICE '(46727 absent from _http_response entirely)';
  ELSE
    RAISE NOTICE 'tally: %', v->'tally';
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
      RAISE NOTICE '  % | % | % | items % with price % | %',
        rpad(COALESCE(r.c->>'order_id','-'),21), COALESCE(r.c->>'asin','-'),
        rpad(COALESCE(r.c->'now'->>'status', r.c->>'action','-'),9),
        COALESCE(r.c->>'items_returned','-'), COALESCE(r.c->>'items_with_price','-'),
        CASE WHEN COALESCE(r.c->'now'->>'sold_price','null')='null' THEN 'no price'
             ELSE '$'||(r.c->'now'->>'sold_price') END;
    END LOOP;
  END IF;
END
$p$;
