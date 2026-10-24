-- February's unpaired amounts in full, plus two checks the pre-flight raised.
-- READ-ONLY.
DO $p$
DECLARE r record; v_uid uuid; v_body jsonb; v_ms jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== did deactivating seller-catalog-queue-topup take effect? ==';
  FOR r IN
    SELECT j.active,
           to_char(max(d.start_time),'MM-DD HH24:MI:SS') AS last_run,
           count(*) FILTER (WHERE d.start_time >= now() - interval '1 hour') AS runs_last_hour
    FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.jobname = 'seller-catalog-queue-topup'
    GROUP BY j.active
  LOOP
    RAISE NOTICE '   active % | last run ever % | runs in the last hour %',
      r.active, r.last_run, r.runs_last_hour;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the new sampler? ==';
  FOR r IN
    SELECT j.jobname, j.schedule, count(d.runid) AS runs,
           round(avg(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,2) AS avg_s,
           count(d.runid) FILTER (WHERE d.status <> 'succeeded') AS failed
    FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid=j.jobid
      AND d.start_time >= now() - interval '1 hour'
    WHERE j.jobname = 'capture-slow-queries-5m' GROUP BY 1,2
  LOOP RAISE NOTICE '   % | % | % runs last hour | avg % s | % failed', r.jobname, r.schedule, r.runs, r.avg_s, r.failed; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   rows the filtered sampler has added since the change:';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE application_name ILIKE 'realtime_replication%') AS walsenders,
           count(*) FILTER (WHERE COALESCE(query,'') ILIKE '%net.http_post%') AS http
    FROM public.slow_query_samples WHERE sampled_at >= now() - interval '1 hour'
  LOOP RAISE NOTICE '      % rows in the last hour | % WAL senders | % http wrappers (both should be 0)',
    r.n, r.walsenders, r.http; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '################ FEBRUARY unpaired amounts, in full ################';
  v_body := public.repull_find_report('2026-02-01'::date, false, NULL, true);
  v_ms := v_body->'api_amount_multiset';

  RAISE NOTICE '   NOTE on rate limits: this dry run recorded % rate-limit hits.',
    v_body->>'rate_limit_hits';
  RAISE NOTICE '   Every other month that has been measured recorded 0.';

  FOR r IN
    WITH api AS (
      SELECT round(x::numeric,2) AS amt, count(*) AS n
      FROM jsonb_array_elements_text(COALESCE(v_ms->'reversal_reimbursement','[]'::jsonb)) AS t(x)
      GROUP BY 1
    ), cur AS (
      SELECT round(reversal_reimbursement,2) AS amt, count(*) AS n
      FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type='adjustment'
        AND event_date >= '2026-02-01' AND event_date < '2026-03-01'
        AND COALESCE(reversal_reimbursement,0) <> 0
      GROUP BY 1
    )
    SELECT COALESCE(api.amt,cur.amt) AS amt, COALESCE(cur.n,0) AS sn, COALESCE(api.n,0) AS an
    FROM api FULL OUTER JOIN cur ON cur.amt = api.amt
    WHERE COALESCE(api.n,0) <> COALESCE(cur.n,0)
    ORDER BY 1
  LOOP
    RAISE NOTICE '   reversal_reimbursement % | stored % -> api % | %',
      lpad(r.amt::text,10), lpad(r.sn::text,3), lpad(r.an::text,3),
      CASE WHEN r.an > r.sn THEN 'appeared' ELSE 'vanished' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   the 0.13 vs 0.14 cent:';
  RAISE NOTICE '      per-column delta sums to +0.14, the header residual reads +0.13.';
  RAISE NOTICE '      api_signed_total and api_clawback_total are each rounded to 2dp';
  RAISE NOTICE '      independently, so their difference carries up to a cent of rounding.';
  RAISE NOTICE '      Not a discrepancy in the data.';

  RAISE NOTICE '';
  RAISE NOTICE '   clawback amounts February would book:';
  FOR r IN
    SELECT round(x::numeric,2) AS amt, count(*) AS n
    FROM jsonb_array_elements_text(COALESCE(v_ms->'compensated_clawback','[]'::jsonb)) AS t(x)
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % x %', lpad(r.amt::text,9), r.n; END LOOP;
END
$p$;
