-- READ-ONLY. What actually happened on 2026-10-18 08:55 GMT, and how often
-- does this class of alert fire? (Rewritten in place: the first version used
-- first_seen_at/last_seen_at/occurrences, which do not exist. Real columns
-- are last_detected_at / error_message / notify_count.)
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== actual columns on spapi_health_alerts ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spapi_health_alerts'
  LOOP
    RAISE NOTICE '   %', r.cols;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the alert rows, newest first ==';
  FOR r IN
    SELECT issue_type, status, created_at, last_detected_at,
           COALESCE(resolved_at::text,'(open)') AS resolved,
           COALESCE(last_notified_at::text,'never') AS notified,
           COALESCE(notify_count::text,'-') AS ncount,
           left(COALESCE(error_message,''), 160) AS err
    FROM public.spapi_health_alerts
    WHERE user_id = v_uid
    ORDER BY created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | % | created % | last seen %',
      rpad(r.issue_type,18), rpad(r.status,8), r.created_at, r.last_detected_at;
    RAISE NOTICE '        resolved % | notified % (x%)', r.resolved, r.notified, r.ncount;
    RAISE NOTICE '        err: %', r.err;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no alert rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how long was it actually broken? ==';
  FOR r IN
    SELECT issue_type, created_at, resolved_at, (resolved_at - created_at) AS duration
    FROM public.spapi_health_alerts
    WHERE user_id = v_uid AND resolved_at IS NOT NULL
    ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '   % | % -> % | lasted %',
      rpad(r.issue_type,16), r.created_at, r.resolved_at, r.duration;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none resolved)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== frequency by issue_type, all time ==';
  FOR r IN
    SELECT issue_type, count(*) AS alerts,
           count(*) FILTER (WHERE last_notified_at IS NOT NULL) AS emailed,
           count(*) FILTER (WHERE status = 'open') AS still_open
    FROM public.spapi_health_alerts WHERE user_id = v_uid
    GROUP BY 1 ORDER BY alerts DESC
  LOOP
    RAISE NOTICE '   % | % alerts | % emailed | % open',
      rpad(r.issue_type,18), lpad(r.alerts::text,4), lpad(r.emailed::text,4), r.still_open;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many "other" alerts are really TRANSPORT errors? ==';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE lower(COALESCE(error_message,'')) ~
             'connection reset|connection error|sendrequest|econnreset|broken pipe|connection closed|handshake|socket|eof|refused|unreachable'
           ) AS transport_shaped
    FROM public.spapi_health_alerts
    WHERE user_id = v_uid AND issue_type = 'other'
  LOOP
    RAISE NOTICE '   of % "other" alerts, % are transport-level and should never have emailed',
      r.total, r.transport_shaped;
  END LOOP;
END
$p$;
