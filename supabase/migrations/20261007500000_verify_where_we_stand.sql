-- READ-ONLY. State of play, measured rather than remembered.
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO n FROM public.sales_orders
  WHERE order_status IN ('Canceled','Cancelled')
    AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%';
  RAISE NOTICE 'STEP 1  Canceled-but-unflagged rows remaining: % (want 0)', n;

  SELECT count(*) INTO n FROM public.cron_run_history
  WHERE job_name = 'sync-order-status-updates-hourly';
  RAISE NOTICE 'STEP 4  cron_run_history rows for job 170: % (was 0 forever)', n;
  FOR r IN SELECT status, started_at, items_processed,
                  COALESCE(detail->>'ordersSeen','-') AS seen
           FROM public.cron_run_history
           WHERE job_name = 'sync-order-status-updates-hourly'
           ORDER BY started_at DESC LIMIT 3 LOOP
    RAISE NOTICE '          % | % | % updated | % seen', r.started_at, r.status, r.items_processed, r.seen;
  END LOOP;

  SELECT count(*) INTO n FROM public.backup_resolve_stuck_pending_20261007;
  RAISE NOTICE 'STEP 3  rows written by the resolver: % (want 0 -- not applied)', n;

  FOR r IN
    SELECT count(*) AS orders, round(sum(estimated_price * quantity)::numeric,2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(sold_price,0)=0 AND COALESCE(estimated_price,0)>0
      AND COALESCE(is_cancelled,false)=false AND order_id NOT LIKE '%-REFUND%'
      AND order_date <= current_date - 90
  LOOP
    RAISE NOTICE 'STEP 3  cohort still open: % orders | $%', r.orders, r.est;
  END LOOP;

  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled, so.order_status,
             so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0)=0
        AND COALESCE(so.estimated_price,0)>0 AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false)::numeric,2) AS a,
           round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false
                 AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled'))::numeric,2) AS b
    FROM base
  LOOP
    RAISE NOTICE 'LIVE    estimated revenue counted: Rule A $% | Rule B $% (started $36597.24)', r.a, r.b;
  END LOOP;

  FOR r IN SELECT count(*) AS rows, round(sum(sales)::numeric,2) AS sales
           FROM public.financial_events_cache WHERE user_id = v_uid LOOP
    RAISE NOTICE 'P&L     % rows | sales $% (baseline 120429 | $2463045.47)', r.rows, r.sales;
  END LOOP;
END
$p$;
