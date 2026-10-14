-- READ-ONLY. Three questions in one pass, plus the drain confirmation.
-- Nothing is applied.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- ── 0. drain ─────────────────────────────────────────────────────────────
  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'drain-stuck-pending-5m';
  RAISE NOTICE '== DRAIN: job 195 scheduled: % (0 = gone) ==', n;
  FOR r IN
    SELECT count(*) AS cohort
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0) = 0
      AND COALESCE(so.estimated_price,0) > 0 AND COALESCE(so.is_cancelled,false) = false
      AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date <= current_date - 90
      AND COALESCE(so.price_confidence,'') <> 'ESTIMATE_UNRECOVERABLE'
      AND NOT EXISTS (SELECT 1 FROM public.stuck_pending_attempts a
                      WHERE a.order_id = so.order_id AND a.attempts >= 3)
  LOOP
    RAISE NOTICE '   eligible cohort: % (0 = finished)', r.cohort;
  END LOOP;
  FOR r IN
    SELECT CASE WHEN new_is_cancelled THEN 'cancelled'
                WHEN price_recovered THEN 'shipped - price recovered'
                ELSE 'shipped - ESTIMATE_UNRECOVERABLE' END AS bucket,
           count(*) AS orders, round(sum(estimated_price)::numeric, 2) AS est
    FROM (SELECT DISTINCT ON (order_id) order_id, new_is_cancelled, price_recovered, estimated_price
          FROM public.stuck_pending_resolution_log
          WHERE resolved_at > '2026-10-10 13:00:00+00'
          ORDER BY order_id, resolved_at DESC) t
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders | $%', rpad(r.bucket, 34), lpad(r.orders::text, 4), r.est;
  END LOOP;

  -- ── 2. business customer ─────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== 2. is there a business flag on the row at all? ==';
  FOR r IN
    SELECT COALESCE(order_type, '(null)') AS ot, count(*) AS orders,
           count(*) FILTER (WHERE upper(COALESCE(marketplace,'')) = 'CA') AS ca_orders
    FROM public.sales_orders WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC LIMIT 8
  LOOP
    RAISE NOTICE '   order_type % | % orders | % of them CA', rpad(r.ot, 22), lpad(r.orders::text, 7), r.ca_orders;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2b. does a multi-unit CA order sell below the single-unit price? ==';
  RAISE NOTICE '   (quantity discount would show as a falling per-unit price)';
  FOR r IN
    SELECT quantity, count(*) AS orders,
           round(avg(sold_price)::numeric, 2) AS avg_unit_usd,
           round(avg(estimated_price)::numeric, 2) AS avg_est_native
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'')) = 'CA'
      AND COALESCE(sold_price,0) > 0 AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND%' AND order_date > current_date - 365
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1
  LOOP
    RAISE NOTICE '   qty % | % orders | sold $%/unit | estimate % native',
      lpad(r.quantity::text, 3), lpad(r.orders::text, 5), lpad(r.avg_unit_usd::text, 8),
      COALESCE(r.avg_est_native::text, '-');
  END LOOP;

  -- ── 4. price-estimate replay on settled CA orders ────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== 4. REPLAY on settled CA orders: three ways to estimate ==';
  RAISE NOTICE '   A = what we do now (estimated_price, native, converted)';
  RAISE NOTICE '   B = Buy Box captured at order time (bb_estimate_price)';
  RAISE NOTICE '   C = last settled price for the same ASIN before this purchase';
  FOR r IN
    WITH ca AS (
      SELECT so.order_id, so.asin, so.quantity, so.sold_price, so.order_date,
             so.estimated_price / NULLIF(fx.rate, 1) AS est_a_usd,
             so.bb_estimate_price AS bb_raw,
             so.bb_estimate_qualified
      FROM public.sales_orders so
      CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1) fx
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'')) = 'CA'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), withC AS (
      SELECT c.*,
             (SELECT p.sold_price FROM public.sales_orders p
              WHERE p.user_id = v_uid AND p.asin = c.asin
                AND upper(COALESCE(p.marketplace,'')) = 'CA'
                AND COALESCE(p.sold_price,0) > 0 AND p.order_date < c.order_date
                AND p.order_id NOT LIKE '%-REFUND%'
              ORDER BY p.order_date DESC LIMIT 1) AS est_c_usd
      FROM ca c
    )
    SELECT
      count(*) AS orders,
      count(*) FILTER (WHERE est_a_usd > 0) AS have_a,
      count(*) FILTER (WHERE bb_raw > 0) AS have_b,
      count(*) FILTER (WHERE est_c_usd > 0) AS have_c,
      round((100 * avg(abs(est_a_usd - sold_price) / NULLIF(sold_price,0))
             FILTER (WHERE est_a_usd > 0))::numeric, 1) AS a_abs_err_pct,
      round((100 * avg(abs(est_c_usd - sold_price) / NULLIF(sold_price,0))
             FILTER (WHERE est_c_usd > 0))::numeric, 1) AS c_abs_err_pct,
      round((100 * avg((est_a_usd - sold_price) / NULLIF(sold_price,0))
             FILTER (WHERE est_a_usd > 0))::numeric, 1) AS a_bias_pct,
      round((100 * avg((est_c_usd - sold_price) / NULLIF(sold_price,0))
             FILTER (WHERE est_c_usd > 0))::numeric, 1) AS c_bias_pct
    FROM withC
  LOOP
    RAISE NOTICE '   % settled CA orders in the last year', r.orders;
    RAISE NOTICE '   coverage: A % | B (buy box) % | C (last settled) %', r.have_a, r.have_b, r.have_c;
    RAISE NOTICE '   A  mean ABSOLUTE error % pct | bias % pct', r.a_abs_err_pct, r.a_bias_pct;
    RAISE NOTICE '   C  mean ABSOLUTE error % pct | bias % pct', r.c_abs_err_pct, r.c_bias_pct;
    RAISE NOTICE '   (absolute error is the honest measure -- bias lets a high';
    RAISE NOTICE '    estimate and a low one cancel into a flattering average)';
  END LOOP;
END
$p$;
