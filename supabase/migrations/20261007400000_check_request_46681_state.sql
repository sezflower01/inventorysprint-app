DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== replies since the resolver dry runs ==';
  FOR r IN SELECT id, status_code, created, left(COALESCE(content,''), 160) AS body
           FROM net._http_response WHERE id >= 46646 ORDER BY id LOOP
    RAISE NOTICE '  reply % | http % | % | %', r.id, r.status_code, r.created, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none at all)'; END IF;
END
$p$;
