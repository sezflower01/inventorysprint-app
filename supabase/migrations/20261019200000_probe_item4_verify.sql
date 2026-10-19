-- READ-ONLY. Condition 3: the sync runs since the item-4 deploy at
-- 2026-10-19 19:49:54 UTC. Baseline was NULL 57,515 | AFN 14,100 | MFN 124.
DO $p$
DECLARE v_uid uuid; r record; v_deploy timestamptz := '2026-10-19 19:49:54+00';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '== now % | deploy was % ==', date_trunc('second', now()), v_deploy;

  RAISE NOTICE '';
  RAISE NOTICE '== sync runs since the deploy ==';
  FOR r IN
    SELECT j.jobname, count(*) AS runs,
           count(*) FILTER (WHERE d.status = 'succeeded') AS ok,
           count(*) FILTER (WHERE d.status <> 'succeeded') AS not_ok,
           max(d.start_time) AS latest
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time > v_deploy
      AND (j.jobname ILIKE '%sync-sales%' OR j.jobname ILIKE '%auto-sync%'
        OR j.jobname ILIKE '%live-orders%')
    GROUP BY 1 ORDER BY runs DESC
  LOOP
    RAISE NOTICE '   % | % runs | % ok | % failed | latest %',
      rpad(r.jobname,38), lpad(r.runs::text,3), lpad(r.ok::text,3), r.not_ok, r.latest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no sync runs since the deploy yet)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== NEW rows created since the deploy: do they carry a channel? ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders
    FROM public.sales_orders
    WHERE user_id = v_uid AND created_at > v_deploy AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders', rpad(r.fc,8), r.orders;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no new rows yet -- nothing to measure)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== totals now, vs the baseline ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders
    FROM public.sales_orders WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders', rpad(r.fc,8), lpad(r.orders::text,6);
  END LOOP;
  RAISE NOTICE '   baseline was: NULL 57,515 | AFN 14,100 | MFN 124';

  RAISE NOTICE '';
  RAISE NOTICE '== FBA-DEPENDENT VALUES ON EXISTING ROWS: did anything shift? ==';
  FOR r IN
    SELECT count(*) AS rows,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba_total,
           round(sum(COALESCE(referral_fee,0))::numeric,2) AS referral_total,
           round(sum(COALESCE(total_fees,0))::numeric,2) AS fees_total
    FROM public.sales_orders
    WHERE user_id = v_uid AND created_at <= v_deploy AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   pre-deploy rows: % | fba % | referral % | total_fees %',
      r.rows, r.fba_total, r.referral_total, r.fees_total;
    RAISE NOTICE '   (re-run this later; these must not move except where a';
    RAISE NOTICE '    normal re-enrichment legitimately updates fees)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== error_reports columns (the first version guessed "source") ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='error_reports'
  LOOP
    RAISE NOTICE '   %', COALESCE(r.cols,'(table not found)');
  END LOOP;
END
$p$;
