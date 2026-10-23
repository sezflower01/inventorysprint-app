DO $p$
DECLARE r record; v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '== queue depth % ==', v_n;
  FOR r IN
    SELECT id, left(regexp_replace(url,'^.*/functions/v1/',''), 40) AS fn, timeout_milliseconds AS t
    FROM net.http_request_queue ORDER BY id
  LOOP RAISE NOTICE '   % | % | timeout %ms', r.id, rpad(r.fn,40), r.t; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== total queued timeout if they run serially ==';
  FOR r IN SELECT round(sum(timeout_milliseconds)/1000.0,0) AS secs FROM net.http_request_queue
  LOOP RAISE NOTICE '   worst case % seconds of queue ahead', r.secs; END LOOP;
END
$p$;
