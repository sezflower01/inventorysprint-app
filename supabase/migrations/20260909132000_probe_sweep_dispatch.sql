-- PROBE (read-only): seven batches were dispatched and none produced a response
-- row, while the shortlist stayed at 436. So they did not run. Find out where
-- they stopped before dispatching anything else.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_cols text;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== are they still queued? ========';
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'net' AND table_name = 'http_request_queue';
  RAISE NOTICE '   queue columns: %', COALESCE(v_cols,'(absent)');

  BEGIN
    FOR r IN
      SELECT id, url FROM net.http_request_queue WHERE id BETWEEN 61367 AND 61373
    LOOP
      RAISE NOTICE '   STILL QUEUED id=% url=%', r.id, left(r.url, 90);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (queue unreadable: %)', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== every response in the last 20 minutes ========';
  FOR r IN
    SELECT id, status_code, left(content::text, 150) AS body, created
    FROM net._http_response
    WHERE created > now() - interval '20 minutes'
    ORDER BY id DESC LIMIT 20
  LOOP
    RAISE NOTICE '   id=% % | % | %', r.id, r.created, r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== highest response id on record ========';
  FOR r IN SELECT max(id) AS mx, count(*) AS n FROM net._http_response
  LOOP
    RAISE NOTICE '   max id=%  rows=%', r.mx, r.n;
    RAISE NOTICE '   (the sweep asked for 61367-61373)';
  END LOOP;
END
$probe$;
