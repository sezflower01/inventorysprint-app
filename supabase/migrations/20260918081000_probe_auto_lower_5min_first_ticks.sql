-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- First real ticks of repricer-auto-lower-min-5min (#191, 3-58/5):
--   20:03 -> all three rules due (never run), processed and stamped;
--   20:08 -> no rule due (60-minute interval), nothing processed.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT d.start_time, d.status FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
           WHERE j.jobname = 'repricer-auto-lower-min-5min' ORDER BY d.start_time DESC LIMIT 3 LOOP
    RAISE NOTICE 'cron tick % %', r.start_time, r.status;
  END LOOP;

  FOR r IN SELECT created, left(regexp_replace(content, '\s+', ' ', 'g'), 330) AS head
           FROM net._http_response
           WHERE created > '2026-09-18 20:02:00+00' AND content LIKE '%auto-lower%' OR (created > '2026-09-18 20:02:00+00' AND content LIKE '%rules_due%') OR (created > '2026-09-18 20:02:00+00' AND content LIKE '%no rule due%')
           ORDER BY created LIMIT 4 LOOP
    RAISE NOTICE 'response %: %', to_char(r.created, 'HH24:MI:SS'), r.head;
  END LOOP;

  FOR r IN SELECT to_jsonb(h) AS j FROM public.cron_run_history h
           WHERE to_jsonb(h)::text LIKE '%repricer-auto-lower-min%' AND (to_jsonb(h)->>'started_at')::timestamptz > '2026-09-18 20:00:00+00'
           ORDER BY (to_jsonb(h)->>'started_at') LIMIT 3 LOOP
    RAISE NOTICE 'run %: rules on % due % | considered % | lowered % | skips %', r.j->>'started_at',
      r.j->'detail'->>'rules_on', r.j->'detail'->>'rules_due', r.j->'detail'->>'considered', r.j->'detail'->>'written', r.j->'detail'->'skip_reasons';
    RAISE NOTICE '   lowered: %', (SELECT string_agg((d->>'asin') || ' ' || (d->>'current_min') || '->' || (d->>'new_min') || ' [' || COALESCE(d->>'anchor','') || ', ' || COALESCE(d->>'snapshot_age_min','?') || ' min old]', '; ')
                                 FROM jsonb_array_elements(r.j->'detail'->'decisions') d WHERE d->>'action' = 'lower');
  END LOOP;

  FOR r IN SELECT name, auto_lower_min_last_run_at FROM public.repricer_rules WHERE array_length(auto_lower_min_marketplaces, 1) > 0 LOOP
    RAISE NOTICE 'rule "%" last run %', r.name, r.auto_lower_min_last_run_at;
  END LOOP;
END
$p$;
