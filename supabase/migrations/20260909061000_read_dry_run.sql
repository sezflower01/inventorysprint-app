-- Read the dry-run result.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT status_code, content::text AS body, created
    FROM net._http_response WHERE id = 60562
  LOOP
    RAISE NOTICE 'status % at %', r.status_code, r.created;
    RAISE NOTICE '%', left(r.body, 3500);
  END LOOP;
END
$probe$;
