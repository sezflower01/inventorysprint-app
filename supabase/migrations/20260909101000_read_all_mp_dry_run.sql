-- Read the all-marketplace dry run.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  FOR r IN SELECT status_code, content::text AS body FROM net._http_response WHERE id = 61333
  LOOP
    RAISE NOTICE 'status %', r.status_code;
    RAISE NOTICE '%', left(r.body, 4000);
  END LOOP;
END
$probe$;
