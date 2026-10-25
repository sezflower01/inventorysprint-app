-- READ-ONLY. The pre-flight tripped on pg_net queue depth 2, but none were
-- repull calls. Is this ordinary background traffic or something stuck?
DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== what is actually queued ==';
  FOR r IN
    SELECT left(to_jsonb(q)::text, 300) AS j
    FROM net.http_request_queue q LIMIT 6
  LOOP RAISE NOTICE '   %', r.j; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   queue is now EMPTY'; END IF;

  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '   depth now: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== any pl_sync_progress NOT completed? ==';
  FOR r IN
    SELECT status, count(*) AS n, max(created_at) AS newest
    FROM public.pl_sync_progress GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   status % | % rows | newest %', rpad(r.status,14), r.n, r.newest; END LOOP;

  SELECT count(*) INTO v_n FROM public.pl_sync_progress
  WHERE lower(COALESCE(status,'')) NOT IN ('completed','error','failed')
    AND created_at > now() - interval '2 hours';
  RAISE NOTICE '   in-flight in the last 2h: %', v_n;
END
$p$;
