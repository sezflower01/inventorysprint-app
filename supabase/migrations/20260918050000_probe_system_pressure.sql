-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: "all pages: Loading...". Is the database under pressure right now?

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  FOR r IN SELECT count(*) AS total,
                  count(*) FILTER (WHERE state = 'active') AS active,
                  count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx,
                  count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting_on_lock,
                  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn
           FROM pg_stat_activity WHERE backend_type = 'client backend' LOOP
    RAISE NOTICE 'connections: % of % | active % | idle-in-transaction % | waiting on a lock %',
      r.total, r.max_conn, r.active, r.idle_in_tx, r.waiting_on_lock;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== active queries, longest first ==';
  FOR r IN SELECT pid, usename, application_name, state, wait_event_type, wait_event,
                  round(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 1) AS secs,
                  left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS q
           FROM pg_stat_activity
           WHERE backend_type = 'client backend' AND state <> 'idle' AND pid <> pg_backend_pid()
           ORDER BY query_start NULLS LAST LIMIT 15 LOOP
    RAISE NOTICE '  pid % % [%] % %/% %s | %', r.pid, r.usename, r.application_name, r.state, r.wait_event_type, r.wait_event, r.secs, r.q;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== blocked -> blocker ==';
  FOR r IN SELECT a.pid AS blocked, b.pid AS blocker,
                  left(regexp_replace(a.query, '\s+', ' ', 'g'), 80) AS blocked_q,
                  left(regexp_replace(b.query, '\s+', ' ', 'g'), 80) AS blocker_q,
                  round(EXTRACT(EPOCH FROM (now() - b.xact_start))::numeric, 0) AS blocker_tx_secs
           FROM pg_stat_activity a
           JOIN LATERAL unnest(pg_blocking_pids(a.pid)) bp(pid) ON true
           JOIN pg_stat_activity b ON b.pid = bp.pid LIMIT 10 LOOP
    RAISE NOTICE '  % blocked by % (tx %s) | % <- %', r.blocked, r.blocker, r.blocker_tx_secs, r.blocked_q, r.blocker_q;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cron: runs in the last 30 min that failed or are still running ==';
  FOR r IN SELECT j.jobname, d.status, count(*) AS n, max(d.start_time) AS last
           FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
           WHERE d.start_time > now() - interval '30 minutes' AND d.status <> 'succeeded'
           GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % % x% (last %)', r.jobname, r.status, r.n, r.last;
  END LOOP;

  FOR r IN SELECT count(*) AS queued FROM net.http_request_queue LOOP
    RAISE NOTICE 'pg_net queue: % pending', r.queued;
  END LOOP;
  FOR r IN SELECT count(*) FILTER (WHERE status_code >= 500 OR timed_out OR error_msg IS NOT NULL) AS bad, count(*) AS n
           FROM net._http_response WHERE created > now() - interval '15 minutes' LOOP
    RAISE NOTICE 'edge calls from cron, last 15 min: % of % failed/timed out', r.bad, r.n;
  END LOOP;
END
$p$;
