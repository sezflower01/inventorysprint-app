DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== is 39338 queued, answered, or lost? ==';
  RAISE NOTICE '   in request queue : %', EXISTS(SELECT 1 FROM net.http_request_queue WHERE id=39338);
  RAISE NOTICE '   has response row : %', EXISTS(SELECT 1 FROM net._http_response WHERE id=39338);
  RAISE NOTICE '';
  RAISE NOTICE '== responses since 39338 (is the worker past it?) ==';
  FOR r IN
    SELECT id, status_code, COALESCE(length(content),0) AS len, created
    FROM net._http_response WHERE id >= 39330 ORDER BY id LIMIT 8
  LOOP RAISE NOTICE '   % | % | len % | %', r.id, COALESCE(r.status_code::text,'-'), r.len, r.created; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none at or after 39330'; END IF;
  RAISE NOTICE '';
  RAISE NOTICE '== June adjustment rows stored (how big is the month?) ==';
  FOR r IN
    SELECT count(*) AS adj,
           (SELECT count(*) FROM public.financial_events_cache
            WHERE user_id=v_uid AND event_date>='2026-06-01' AND event_date<'2026-07-01') AS total
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date>='2026-06-01' AND event_date<'2026-07-01'
  LOOP RAISE NOTICE '   % adjustment rows of % total', r.adj, r.total; END LOOP;
END
$p$;
