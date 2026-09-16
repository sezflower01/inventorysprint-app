-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Is the new-code dry-run request still queued in pg_net, or did it fail?

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT id, method, url, left(body::text, 120) AS body FROM net.http_request_queue ORDER BY id DESC LIMIT 5 LOOP
    RAISE NOTICE '  queued #% % % %', r.id, r.method, r.url, r.body;
  END LOOP;
  FOR r IN SELECT id, created, status_code, error_msg, left(content, 300) AS head
           FROM net._http_response
           WHERE created > now() - interval '10 minutes'
             AND (content LIKE '%auto-lower%' OR content LIKE '%considered%' OR status_code >= 400 OR error_msg IS NOT NULL)
           ORDER BY created DESC LIMIT 6 LOOP
    RAISE NOTICE '  resp #% % status=% err=% | %', r.id, r.created, r.status_code, r.error_msg, r.head;
  END LOOP;
END
$p$;
