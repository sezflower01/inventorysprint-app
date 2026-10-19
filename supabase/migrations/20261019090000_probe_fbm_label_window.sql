-- READ-ONLY. FBM label costs are not retrieved automatically for MTD; the
-- seller is entering them by hand. The orders shown are 2026-10-04 to
-- 2026-10-10, i.e. 9-15 days old today, and poll-fbm-label-costs only
-- considers rows younger than WINDOW_DAYS = 7.
--
-- Its own header already says the parameter exists but "Default stays 7, so
-- the 30-minute cron is completely unchanged. A caller that wants history
-- passes windowDays explicitly." Nothing does.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1. does the cron pass windowDays? ==';
  FOR r IN
    SELECT jobid, jobname, schedule,
           left(regexp_replace(command, '\s+', ' ', 'g'), 300) AS cmd
    FROM cron.job WHERE jobname ILIKE '%fbm%label%' OR command ILIKE '%poll-fbm-label-costs%'
  LOOP
    RAISE NOTICE '   [%] % | %', r.jobid, r.jobname, r.schedule;
    RAISE NOTICE '        %', r.cmd;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no cron job references poll-fbm-label-costs)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1b. IS job 172 ACTUALLY SUCCEEDING? (it uses an anon apikey) ==';
  FOR r IN
    SELECT status, count(*) AS runs, max(start_time) AS latest
    FROM cron.job_run_details WHERE jobid = 172 AND start_time > now() - interval '24 hours'
    GROUP BY 1 ORDER BY runs DESC
  LOOP
    RAISE NOTICE '   % | % runs in 24h | latest %', rpad(r.status,12), r.runs, r.latest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no runs in 24h)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. the MTD FBM orders still awaiting a label fee ==';
  FOR r IN
    SELECT so.order_id, so.order_date,
           (CURRENT_DATE - so.order_date)::int AS age_days,
           so.quantity AS qty,
           COALESCE(so.sold_price,0) AS sold,
           COALESCE(so.shipping_label_fee::text,'NULL') AS label_fee,
           COALESCE(so.shipping_label_fee_source,'(none)') AS src,
           COALESCE(so.shipping_label_fee_poll_attempts::text,'-') AS attempts,
           COALESCE(so.shipping_label_fee_last_polled_at::text,'never') AS last_poll,
           COALESCE(so.fulfillment_channel,'-') AS fc
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.order_date >= date_trunc('month', CURRENT_DATE)
      AND upper(COALESCE(so.fulfillment_channel,'')) LIKE 'MFN%'
      AND COALESCE(so.is_cancelled,false) = false
      AND so.order_id NOT LIKE '%-REFUND%'
    ORDER BY so.order_date DESC
  LOOP
    RAISE NOTICE '   % | % (% d old) | q% | sold % | fee % from %',
      r.order_id, r.order_date, lpad(r.age_days::text,2), r.qty,
      lpad(r.sold::text,6), lpad(r.label_fee,7), rpad(r.src,18);
    RAISE NOTICE '        attempts % | last polled % | channel %',
      r.attempts, r.last_poll, r.fc;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no MFN orders this month -- check the channel tag)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. how many are INSIDE vs OUTSIDE the 7-day window? ==';
  FOR r IN
    SELECT CASE WHEN (CURRENT_DATE - order_date) <= 7 THEN 'inside 7d (cron sees it)'
                ELSE 'OUTSIDE 7d (cron ignores it)' END AS bucket,
           count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(shipping_label_fee,0) = 0) AS no_fee
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND upper(COALESCE(fulfillment_channel,'')) LIKE 'MFN%'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= date_trunc('month', CURRENT_DATE)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | % still without a fee', rpad(r.bucket,30), r.orders, r.no_fee;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. the whole year: coverage and the money involved ==';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon, count(*) AS mfn_orders,
           count(*) FILTER (WHERE COALESCE(shipping_label_fee,0) > 0) AS with_fee,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS fee_total,
           count(*) FILTER (WHERE COALESCE(shipping_label_fee_source,'') = 'manual') AS manual_entries
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND upper(COALESCE(fulfillment_channel,'')) LIKE 'MFN%'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= CURRENT_DATE - 365
    GROUP BY 1 ORDER BY 1 DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % MFN orders | % have a fee | total % | % entered by hand',
      r.mon, lpad(r.mfn_orders::text,4), lpad(r.with_fee::text,4),
      lpad(r.fee_total::text,9), r.manual_entries;
  END LOOP;
END
$p$;
