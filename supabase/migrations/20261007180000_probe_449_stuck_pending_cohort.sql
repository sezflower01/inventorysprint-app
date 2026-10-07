-- READ-ONLY PROBE, step 1 of the stuck-Pending investigation. No writes.
--
-- 449 orders older than three months still carry an estimate and have never
-- settled, worth $11,702.14 of estimated revenue. They cannot reach the P&L
-- (it needs a financial event) but they DO count in Live Sales, so the two
-- reports disagree by construction.
--
-- This probe establishes the cohort and answers two of the four questions from
-- the DB alone, before anything touches Amazon:
--   * are these invisible to the status sync, or has it seen and skipped them?
--   * do any already have a financial event that was never linked back?
-- The Amazon round trip (what does GetOrder say NOW) is a separate step.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- ─────────────────────────────────────────────────────────────────────────
  RAISE NOTICE '== A. the cohort, exactly as Live Sales counts it ==';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           round(sum(estimated_price * quantity)::numeric, 2) AS est_revenue,
           min(order_date) AS oldest, max(order_date) AS newest
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price, 0) = 0 AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date <= current_date - 90
  LOOP
    RAISE NOTICE '  % orders | % units | $% estimated | % .. %',
      r.orders, r.units, r.est_revenue, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== by marketplace and order_status ==';
  FOR r IN
    SELECT COALESCE(marketplace,'?') AS mk, COALESCE(order_status,'(null)') AS st,
           COALESCE(status_source,'(null)') AS ssrc,
           count(*) AS orders, round(sum(estimated_price * quantity)::numeric,2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date <= current_date - 90
    GROUP BY 1,2,3 ORDER BY orders DESC LIMIT 15
  LOOP
    RAISE NOTICE '  % | status % | source % | % orders | $%',
      rpad(r.mk,4), rpad(r.st,12), rpad(r.ssrc,18), lpad(r.orders::text,5), r.est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== by year of purchase: how far back does this go? ==';
  FOR r IN
    SELECT to_char(date_trunc('quarter', order_date), 'YYYY-"Q"Q') AS q,
           count(*) AS orders, round(sum(estimated_price * quantity)::numeric,2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date <= current_date - 90
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | $%', r.q, lpad(r.orders::text,5), r.est;
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== B. has the status sync ever LOOKED at them? ==';
  FOR r IN
    SELECT CASE
             WHEN last_status_sync_at IS NULL                       THEN '1. never synced'
             WHEN last_status_sync_at > now() - interval '7 days'   THEN '2. seen in last 7d'
             WHEN last_status_sync_at > now() - interval '30 days'  THEN '3. seen 7-30d ago'
             WHEN last_status_sync_at > now() - interval '90 days'  THEN '4. seen 30-90d ago'
             ELSE                                                        '5. seen over 90d ago'
           END AS seen,
           count(*) AS orders, round(sum(estimated_price * quantity)::numeric,2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date <= current_date - 90
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | $%', rpad(r.seen,22), lpad(r.orders::text,5), r.est;
  END LOOP;

  -- ─────────────────────────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== C. financial_events_cache columns (so part C can be written correctly) ==';
  FOR r IN SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'financial_events_cache' LOOP
    RAISE NOTICE '  %', r.cols;
  END LOOP;
END
$p$;
