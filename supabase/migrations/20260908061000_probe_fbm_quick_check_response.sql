-- PROBE (read-only): the dispatched fbm-quick-check produced no response row
-- under the id returned by net.http_post. Either it is still in flight, the id
-- is keyed differently, or the gateway rejected the call before the function
-- ran (the verify_jwt trap: pg_cron-style calls send x-internal-secret and no
-- Authorization header).
--
-- Read the recent responses and the deployed verify_jwt flag.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== responses in the last 10 minutes ========';
  FOR r IN
    SELECT id, status_code, left(content::text, 220) AS body, created
    FROM net._http_response
    WHERE created > now() - interval '10 minutes'
    ORDER BY created DESC LIMIT 15
  LOOP
    RAISE NOTICE '   id=% | % | % | %', r.id, r.created, r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is request 36619 still queued? ========';
  BEGIN
    FOR r IN
      SELECT id, url, created FROM net.http_request_queue WHERE id = 36619
    LOOP
      RAISE NOTICE '   still queued: id=% url=% created=%', r.id, r.url, r.created;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (queue unreadable: %)', SQLERRM;
  END;
END
$probe$;
