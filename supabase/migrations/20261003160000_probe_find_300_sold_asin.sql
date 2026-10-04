-- READ-ONLY PROBE. Which ASIN shows "300 sold / net $534.90 / ROI 24% /
-- 78 returned (26.0%)" over the rolling 12 months, and what is the full chain
-- behind those four numbers?
--
-- Asked because the line is hard to read: it mixes a GROSS unit count (300
-- sold, which includes the 78 that later came back), a net money figure that
-- has already had the returns deducted, an ROI measured against cost of goods,
-- and a return rate -- with nothing on screen showing how one leads to the next.

DO $p$
DECLARE v_uid uuid; r record; v_start date; v_end date;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  v_end := current_date;
  v_start := (date_trunc('day', current_date) - interval '12 months')::date;

  RAISE NOTICE 'window % .. %', v_start, v_end;
  RAISE NOTICE '';
  RAISE NOTICE '== candidates: 12-month units between 250 and 350 ==';
  FOR r IN
    WITH sold AS (
      SELECT asin, sum(quantity) AS units
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= v_start AND order_date <= v_end
        AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
      GROUP BY asin
      HAVING sum(quantity) BETWEEN 250 AND 350)
    SELECT s.asin, p.units_sold, p.net_profit, p.net_roi_pct, p.units_returned, p.return_rate_pct
    FROM sold s
    CROSS JOIN LATERAL public.get_asin_profit(s.asin, v_start, v_end) p
    WHERE p.units_returned BETWEEN 60 AND 95
    ORDER BY abs(p.net_profit - 534.90)
    LIMIT 5
  LOOP
    RAISE NOTICE '  % | % sold | net $% | % pct | % returned (% pct)',
      r.asin, r.units_sold, r.net_profit, r.net_roi_pct, r.units_returned, r.return_rate_pct;
  END LOOP;
END
$p$;
