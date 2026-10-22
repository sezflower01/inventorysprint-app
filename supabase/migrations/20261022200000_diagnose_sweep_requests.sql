DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== the three sweep requests, raw ==';
  FOR r IN
    SELECT id, status_code,
           COALESCE(left(error_msg,200),'(no error)') AS err,
           COALESCE(length(content),0) AS content_len,
           left(COALESCE(content,''),300) AS head
    FROM net._http_response WHERE id IN (21165,21166,21167) ORDER BY id
  LOOP
    RAISE NOTICE '   % | status % | len % | err %', r.id, COALESCE(r.status_code::text,'-'), r.content_len, r.err;
    IF r.content_len > 0 THEN RAISE NOTICE '      head: %', r.head; END IF;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO ROWS for 21165-21167 -- still in flight or purged'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== most recent responses overall ==';
  FOR r IN
    SELECT id, status_code, COALESCE(length(content),0) AS len,
           COALESCE(left(error_msg,120),'-') AS err
    FROM net._http_response ORDER BY id DESC LIMIT 6
  LOOP
    RAISE NOTICE '   % | % | len % | %', r.id, COALESCE(r.status_code::text,'-'), r.len, r.err;
  END LOOP;
END
$p$;
