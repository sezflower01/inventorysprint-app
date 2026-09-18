-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- The freshness-guarded dry run did not match the expected marker. Show the
-- newest dry-run-looking responses as they are, including failures.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT id, created, status_code, error_msg, length(content) AS len, left(regexp_replace(content, '\s+', ' ', 'g'), 400) AS head
           FROM net._http_response
           WHERE created > '2026-09-18 19:47:00+00'
             AND (content ILIKE '%dry_run%' OR status_code >= 400 OR error_msg IS NOT NULL OR content ILIKE '%auto-lower%')
           ORDER BY created DESC LIMIT 5 LOOP
    RAISE NOTICE '#% % s=% len=% err=% | %', r.id, r.created, r.status_code, r.len, r.error_msg, r.head;
  END LOOP;
  FOR r IN SELECT count(*) AS q FROM net.http_request_queue LOOP RAISE NOTICE 'queued: %', r.q; END LOOP;
END
$p$;
