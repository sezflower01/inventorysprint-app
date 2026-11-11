-- READ-ONLY PROBE: what actually happened before the 2026-11-11 11:25 "recovered" email?
--
-- The seller received "SP-API connection recovered ... previously open issues
-- (network) have cleared" with no preceding alarm. The suspicion is an
-- asymmetry in _shared/spapi-alert.ts: raiseSpapiAlert INSERTS the open row
-- before deciding whether to email, and suppresses `network` emails until the
-- issue has persisted NETWORK_SUSTAINED_MINUTES (30). resolveSpapiAlerts has
-- no matching check -- it emails on any open row clearing. So a short blip
-- should produce a recovery email for an incident never reported.
--
-- notify_count is the discriminator: 0 means no alarm email was ever sent.
DO $$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '=== spapi_health_alerts, last 7 days ===';
  FOR r IN
    SELECT issue_type, status, notify_count,
           first_detected_at, last_detected_at, resolved_at,
           round(EXTRACT(EPOCH FROM (COALESCE(resolved_at, last_detected_at) - first_detected_at))/60.0, 2) AS open_minutes,
           left(coalesce(error_message,''), 220) AS err
    FROM spapi_health_alerts
    WHERE first_detected_at > now() - interval '7 days'
    ORDER BY first_detected_at DESC
  LOOP
    RAISE NOTICE 'type=% status=% notified=% open_min=% first=% resolved=%',
      r.issue_type, r.status, r.notify_count, r.open_minutes, r.first_detected_at, r.resolved_at;
    RAISE NOTICE '   err: %', r.err;
  END LOOP;

  SELECT count(*) INTO n FROM spapi_health_alerts WHERE status = 'open';
  RAISE NOTICE '=== still-open alerts right now: % ===', n;
  FOR r IN SELECT issue_type, notify_count, first_detected_at FROM spapi_health_alerts WHERE status='open' LOOP
    RAISE NOTICE '  OPEN type=% notified=% since=%', r.issue_type, r.notify_count, r.first_detected_at;
  END LOOP;

  -- error_reports is written ONLY when an alarm email is actually sent, so its
  -- absence is independent confirmation that nothing was emailed.
  RAISE NOTICE '=== error_reports from the monitor, last 7 days ===';
  FOR r IN
    SELECT created_at, error_message, left(coalesce(error_context,''),160) AS ctx
    FROM error_reports
    WHERE page_url = 'system://spapi-monitor' AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC LIMIT 20
  LOOP
    RAISE NOTICE '  % | % | %', r.created_at, r.error_message, r.ctx;
  END LOOP;

  RAISE NOTICE '=== lifetime counts by issue_type ===';
  FOR r IN
    SELECT issue_type, count(*) AS rows, sum(notify_count) AS emails,
           count(*) FILTER (WHERE notify_count = 0) AS silent_rows
    FROM spapi_health_alerts GROUP BY issue_type ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  % rows=% alarm_emails=% silent(no alarm, but would still send a RECOVERED email)=%',
      r.issue_type, r.rows, r.emails, r.silent_rows;
  END LOOP;
END $$;
