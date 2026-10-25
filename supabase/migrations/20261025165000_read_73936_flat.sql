DO $p$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, status_code,
           replace(left(regexp_replace(COALESCE(content,''), E'\s+', ' ', 'g'), 900), '%', '%%') AS body
    FROM net._http_response WHERE id IN (73936, 73897) ORDER BY id
  LOOP
    RAISE NOTICE '[%] status % | %', r.id, r.status_code, r.body;
  END LOOP;
END
$p$;
