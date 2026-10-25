-- READ-ONLY. What did the May call actually return?
DO $p$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, status_code,
           replace(left(COALESCE(content,''), 1200), '%', '%%') AS body
    FROM net._http_response WHERE id IN (73936, 73897) ORDER BY id
  LOOP
    RAISE NOTICE '== request % | status % ==', r.id, r.status_code;
    RAISE NOTICE '%', r.body;
    RAISE NOTICE '';
  END LOOP;
END
$p$;
