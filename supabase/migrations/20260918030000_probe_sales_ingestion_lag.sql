-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- "Mobile sales takes time to update numbers." The page re-reads the DB every
-- 5s for Today/Yesterday, so any lag is upstream: how long after Amazon
-- records an order does it land in sales_orders, and how long until its price
-- is filled in? Also: which cron jobs pull orders, how often, and are they
-- succeeding right now?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '======== order -> row lag (created_at - purchase_timestamp_utc), last 48h ========';
  FOR r IN
    WITH x AS (
      SELECT EXTRACT(EPOCH FROM (created_at - purchase_timestamp_utc)) / 60.0 AS lag_min,
             to_jsonb(s) AS j
      FROM public.sales_orders s
      WHERE s.user_id = v_uid
        AND s.purchase_timestamp_utc > now() - interval '48 hours'
        AND s.created_at IS NOT NULL
    )
    SELECT count(*) AS n,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_min)::numeric, 1) AS p50,
           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY lag_min)::numeric, 1) AS p90,
           round(max(lag_min)::numeric, 1) AS mx,
           count(*) FILTER (WHERE lag_min <= 5) AS le5,
           count(*) FILTER (WHERE lag_min > 5 AND lag_min <= 15) AS le15,
           count(*) FILTER (WHERE lag_min > 15 AND lag_min <= 60) AS le60,
           count(*) FILTER (WHERE lag_min > 60) AS gt60
    FROM x
  LOOP
    RAISE NOTICE '  orders: %  median lag: % min  p90: % min  max: % min', r.n, r.p50, r.p90, r.mx;
    RAISE NOTICE '  within 5 min: %   5-15: %   15-60: %   over 60: %', r.le5, r.le15, r.le60, r.gt60;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== newest orders right now ========';
  FOR r IN SELECT COALESCE(to_jsonb(s)->>'amazon_order_id', to_jsonb(s)->>'order_id', left(s.id::text, 8)) AS amazon_order_id, purchase_timestamp_utc, created_at, to_jsonb(s)->>'marketplace' AS mkt,
                  to_jsonb(s)->>'order_status' AS st,
                  round(EXTRACT(EPOCH FROM (created_at - purchase_timestamp_utc)) / 60.0, 1) AS lag_min
           FROM public.sales_orders s
           WHERE user_id = v_uid AND purchase_timestamp_utc IS NOT NULL
           ORDER BY purchase_timestamp_utc DESC LIMIT 8 LOOP
    RAISE NOTICE '  % % % ordered % | row created % | lag % min', r.amazon_order_id, r.mkt, r.st, r.purchase_timestamp_utc, r.created_at, r.lag_min;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== cron jobs that pull orders ========';
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
           substring(j.command from 'functions/v1/([a-z0-9-]+)') AS fn,
           (SELECT count(*) FROM cron.job_run_details d WHERE d.jobid = j.jobid AND d.start_time > now() - interval '1 hour') AS runs_1h,
           (SELECT d.status FROM cron.job_run_details d WHERE d.jobid = j.jobid ORDER BY d.start_time DESC LIMIT 1) AS last_status
    FROM cron.job j
    WHERE j.command ~* 'functions/v1/[a-z0-9-]*(sales|order)[a-z0-9-]*'
    ORDER BY fn
  LOOP
    RAISE NOTICE '  #% % [%] active=% -> % | runs/1h=% last=%', r.jobid, r.jobname, r.schedule, r.active, r.fn, r.runs_1h, r.last_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what those functions answered in the last 30 min (pg_net) ========';
  FOR r IN SELECT created, status_code, left(regexp_replace(COALESCE(content, error_msg, ''), '\s+', ' ', 'g'), 200) AS head
           FROM net._http_response
           WHERE created > now() - interval '30 minutes'
             AND (content ILIKE '%order%' OR content ILIKE '%sales%')
           ORDER BY created DESC LIMIT 10 LOOP
    RAISE NOTICE '  % s=% | %', to_char(r.created, 'HH24:MI:SS'), r.status_code, r.head;
  END LOOP;
END
$p$;
