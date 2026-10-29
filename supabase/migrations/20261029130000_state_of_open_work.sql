-- READ-ONLY. Where does the outstanding work actually stand, four days on?
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_sum numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== STAGE 2: clawbacks stored per month, 2026 ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) <> 0) AS claw_rows,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % clawback rows | %', r.m, lpad(r.claw_rows::text,4), lpad(r.claw::text,10);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== any month applied since Sunday? (backup table is the tell) ==';
  FOR r IN
    SELECT backup_month, count(*) AS n, max(backed_up_at) AS taken
    FROM public.fec_repull_backup GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows | taken %', r.backup_month, r.n, r.taken; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no backups -- nothing has been applied'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== fresh dry runs still on file (Sunday 10-25) ==';
  FOR r IN
    SELECT left(month,7) AS m, to_char(max(captured_at),'MM-DD HH24:MI') AS newest,
           count(*) AS runs
    FROM public.repull_reports WHERE report ? 'api_signed_total' AND applied=false
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % runs | newest %', r.m, r.runs, r.newest; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the repaired sales order, still correct? ==';
  FOR r IN
    SELECT quantity AS q, round(sold_price,2) AS unit, round(total_sale_amount,2) AS total,
           round(roi,1) AS roi, price_source AS src, order_status AS st
    FROM public.sales_orders WHERE order_id='113-1305212-7465044'
  LOOP RAISE NOTICE '   qty % | unit % | total % | roi % | % | %', r.q, r.unit, r.total, r.roi, r.src, r.st; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== has the pending-price bug recurred since? (multi-unit, orders_itemprice) ==';
  SELECT count(*) INTO v_n FROM public.sales_orders
  WHERE user_id=v_uid AND order_date >= '2026-10-25'
    AND quantity > 1 AND price_source LIKE 'orders_itemprice%'
    AND sold_price < unit_cost;
  RAISE NOTICE '   % new rows priced below cost since the repair', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== seller-catalog-queue-topup still off? ==';
  FOR r IN SELECT jobname, active, schedule FROM cron.job WHERE jobname='seller-catalog-queue-topup'
  LOOP RAISE NOTICE '   % | active % | %', r.jobname, r.active, r.schedule; END LOOP;
END
$p$;
