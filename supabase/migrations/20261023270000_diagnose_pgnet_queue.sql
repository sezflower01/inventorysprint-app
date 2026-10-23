-- Four pg_net requests have now stalled with no response row. If something is
-- stuck at the head of the queue it would explain every one of them, including
-- the January dry run.
DO $p$
DECLARE r record; v_n bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO v_n FROM net.http_request_queue;
    RAISE NOTICE '== net.http_request_queue: % rows waiting ==', v_n;
    FOR r IN
      SELECT id, left(url, 70) AS url, timeout_milliseconds
      FROM net.http_request_queue ORDER BY id LIMIT 10
    LOOP
      RAISE NOTICE '   % | % | timeout %', r.id, r.url, r.timeout_milliseconds;
    END LOOP;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE '   net.http_request_queue not present in this pg_net version';
  END;

  RAISE NOTICE '';
  RAISE NOTICE '== the stalled ids: any response row at all? ==';
  FOR r IN
    SELECT i AS req FROM unnest(ARRAY[21190,21191,21192,21193,37601,37863]) AS i
  LOOP
    PERFORM 1;
    IF EXISTS (SELECT 1 FROM net._http_response WHERE id = r.req) THEN
      RAISE NOTICE '   % : HAS a response', r.req;
    ELSE
      RAISE NOTICE '   % : none', r.req;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== most recent responses (is the worker alive at all?) ==';
  FOR r IN
    SELECT id, status_code, COALESCE(length(content),0) AS len, created
    FROM net._http_response ORDER BY id DESC LIMIT 5
  LOOP
    RAISE NOTICE '   % | % | len % | %', r.id, COALESCE(r.status_code::text,'-'), r.len, r.created;
  END LOOP;
END
$p$;
