-- Read the second dry-run result.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  FOR r IN SELECT status_code, content::text AS body FROM net._http_response WHERE id = 60595
  LOOP
    RAISE NOTICE 'status %', r.status_code;
    RAISE NOTICE '%', left(r.body, 3500);
  END LOOP;
END
$probe$;
