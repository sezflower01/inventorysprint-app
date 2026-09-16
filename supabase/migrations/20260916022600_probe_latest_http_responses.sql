-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- The new-code dry run had not shown up. Show the newest pg_net responses as
-- they are, including failures, instead of filtering on a success marker.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT id, created, status_code, timed_out, error_msg, length(content) AS len, left(content, 260) AS head
           FROM net._http_response
           WHERE created > now() - interval '20 minutes'
           ORDER BY created DESC LIMIT 6 LOOP
    RAISE NOTICE '  #% % status=% timed_out=% err=% len=% | %', r.id, r.created, r.status_code, r.timed_out, r.error_msg, r.len, r.head;
  END LOOP;
END
$p$;
