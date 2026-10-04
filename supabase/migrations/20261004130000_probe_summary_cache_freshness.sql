-- READ-ONLY PROBE. Is anything the Live Sales pages read behind the orders?
--
-- The pages compute from base tables on every read -- sales_orders,
-- financial_events_cache, inventory, order_price_snapshots -- plus two RPCs
-- (get_fec_daily_shipment_totals, get_authoritative_period_totals) that also
-- aggregate live. So there is no materialised sales summary to go stale.
--
-- But financial_events_cache IS a cache, and it carries the fee, refund and
-- settlement side of every figure on those screens. If its own sync lags the
-- orders sync, the pages show current units against stale money -- which looks
-- exactly like "the numbers are not updating" even though orders are landing.
--
-- So: compare each source's freshness against the newest order row, and list
-- which scheduled job owns each one.

DO $p$
DECLARE v_uid uuid; r record; v_newest_order timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT max(created_at) INTO v_newest_order FROM public.sales_orders WHERE user_id = v_uid;
  RAISE NOTICE 'newest order row written: % (% ago)', v_newest_order, now() - v_newest_order;

  RAISE NOTICE '';
  RAISE NOTICE '== freshness of every source the pages read ==';
  FOR r IN
    SELECT 'sales_orders' AS src, max(created_at) AS newest_write, max(updated_at) AS newest_touch,
           count(*) FILTER (WHERE created_at > now() - interval '6 hours') AS rows_6h
    FROM public.sales_orders WHERE user_id = v_uid
    UNION ALL
    SELECT 'financial_events_cache', max(created_at), max(updated_at),
           count(*) FILTER (WHERE created_at > now() - interval '6 hours')
    FROM public.financial_events_cache WHERE user_id = v_uid
    UNION ALL
    SELECT 'order_price_snapshots', max(created_at), max(created_at),
           count(*) FILTER (WHERE created_at > now() - interval '6 hours')
    FROM public.order_price_snapshots WHERE user_id = v_uid
    UNION ALL
    SELECT 'inventory', max(created_at), max(updated_at),
           count(*) FILTER (WHERE updated_at > now() - interval '6 hours')
    FROM public.inventory WHERE user_id = v_uid
    UNION ALL
    SELECT 'asin_fee_cache', max(created_at), max(updated_at),
           count(*) FILTER (WHERE updated_at > now() - interval '6 hours')
    FROM public.asin_fee_cache WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  %-24s | newest write % | newest touch % | % rows in last 6 h',
      r.src, r.newest_write, r.newest_touch, r.rows_6h;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how far behind the orders is the money cache? ==';
  FOR r IN
    SELECT max(created_at) AS fec_newest,
           v_newest_order - max(created_at) AS behind_orders
    FROM public.financial_events_cache WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  financial_events_cache newest % -> % behind the newest order',
      r.fec_newest, r.behind_orders;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== which jobs own the money side, and are they scheduled? ==';
  FOR r IN SELECT jobid, jobname, schedule, active,
                  substring(command from 'functions/v1/([a-z0-9-]+)') AS fn
           FROM cron.job
           WHERE command ~* '(financial|settlement|fec|refund|reimburse|profit)'
              OR jobname ~* '(financial|settlement|fec|refund|reimburse|profit|pl)'
           ORDER BY jobid LOOP
    RAISE NOTICE '  job % | % | % | active % | %',
      r.jobid, COALESCE(r.jobname, ''), r.schedule, r.active, COALESCE(r.fn, '');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  NONE — the money side has no scheduled refresh'; END IF;
END
$p$;
