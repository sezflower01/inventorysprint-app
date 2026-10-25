-- READ-ONLY. Are the non-US marketplaces still producing sane P&L numbers?
--
-- The international panel reads financial_events_cache per marketplace, so
-- that is what gets checked -- not sales_orders, which only supplies the
-- order_id -> marketplace mapping.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== per marketplace, last 90 days ==';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mp,
           count(*) AS rows,
           round(sum(COALESCE(sales,0))::numeric,2)          AS sales,
           round(sum(COALESCE(refunds,0))::numeric,2)        AS refunds,
           round(sum(COALESCE(referral_fees,0))::numeric,2)  AS referral,
           round(sum(COALESCE(fba_fees,0))::numeric,2)       AS fba,
           round(sum(COALESCE(compensated_clawback,0))::numeric,2) AS clawback,
           max(event_date) AS newest
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= current_date - 90
    GROUP BY 1 ORDER BY sales DESC
  LOOP
    RAISE NOTICE '   % | % rows | sales % | refunds % | referral % | fba % | clawback % | newest %',
      rpad(r.mp,6), lpad(r.rows::text,6), lpad(r.sales::text,10),
      lpad(r.refunds::text,9), lpad(r.referral::text,9), lpad(r.fba::text,9),
      lpad(r.clawback::text,9), r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== fee ratios: referral should sit near 15 pct of sales everywhere ==';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mp,
           round(sum(COALESCE(sales,0))::numeric,2) AS sales,
           round((100.0 * sum(COALESCE(referral_fees,0)) / NULLIF(sum(COALESCE(sales,0)),0))::numeric,1) AS referral_pct,
           round((100.0 * sum(COALESCE(fba_fees,0)) / NULLIF(sum(COALESCE(sales,0)),0))::numeric,1) AS fba_pct
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= current_date - 90 AND event_type = 'shipment'
    GROUP BY 1 HAVING sum(COALESCE(sales,0)) > 0 ORDER BY sales DESC
  LOOP
    RAISE NOTICE '   % | sales % | referral pct % | fba pct %',
      rpad(r.mp,6), lpad(r.sales::text,10), lpad(r.referral_pct::text,6), lpad(r.fba_pct::text,6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== staleness: how old is each marketplace''s newest event? ==';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mp, max(event_date) AS newest,
           (current_date - max(event_date)) AS days_old
    FROM public.financial_events_cache
    WHERE user_id = v_uid
    GROUP BY 1 ORDER BY days_old
  LOOP
    RAISE NOTICE '   % | newest % | % days old %', rpad(r.mp,6), r.newest, lpad(r.days_old::text,4),
      CASE WHEN r.days_old > 7 THEN '  <-- STALE' ELSE '' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== marketplace attribution: sales_orders rows the P&L cannot map ==';
  FOR r IN
    SELECT count(*) FILTER (WHERE marketplace IS NULL OR marketplace = '') AS unmapped,
           count(*) AS total
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 90
  LOOP
    RAISE NOTICE '   % of % recent orders have no marketplace', r.unmapped, r.total;
  END LOOP;
END
$p$;
