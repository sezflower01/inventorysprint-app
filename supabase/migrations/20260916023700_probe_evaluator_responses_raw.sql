-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- No evaluator dry-run response matched. List every pg_net response since the
-- 13:20:29 deploy, failures included, with a short head, to find them.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT id, created, status_code, error_msg, length(content) AS len, left(regexp_replace(content, '\s+', ' ', 'g'), 220) AS head
           FROM net._http_response
           WHERE created > '2026-09-16 13:20:29+00'
           ORDER BY created LIMIT 40 LOOP
    RAISE NOTICE '  #% % s=% len=% err=% | %', r.id, to_char(r.created, 'HH24:MI:SS'), r.status_code, r.len, left(r.error_msg, 60), r.head;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM net.http_request_queue LOOP
    RAISE NOTICE 'still queued: %', r.n;
  END LOOP;
END
$p$;
