DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== tallies from the apply batches: any throttling? ==';
  FOR r IN SELECT id, left(COALESCE(content,''), 230) AS body
           FROM net._http_response WHERE id BETWEEN 51643 AND 51680
             AND content LIKE '%ordersAsked%' ORDER BY id LOOP
    RAISE NOTICE '  % | %', r.id, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no batch replies landed yet)'; END IF;
END
$p$;
