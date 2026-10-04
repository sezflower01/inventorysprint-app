-- READ-ONLY PROBE. B077DY3DRM, every step from revenue to the $534.90 on the
-- panel, so the line can be read rather than trusted.

DO $p$
DECLARE v_uid uuid; r record; v_start date; v_end date;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  v_end := current_date;
  v_start := (date_trunc('day', current_date) - interval '12 months')::date;

  FOR r IN SELECT * FROM public.get_asin_profit('B077DY3DRM', v_start, v_end) LOOP
    RAISE NOTICE 'window % .. %', v_start, v_end;
    RAISE NOTICE '  units sold        %  (in % orders)', r.units_sold, r.orders;
    RAISE NOTICE '  revenue          $%   (avg $%/unit)', r.revenue, r.avg_sale_price;
    RAISE NOTICE '  Amazon fees     -$%', r.fees;
    RAISE NOTICE '  shipping labels -$%', r.label_fees;
    RAISE NOTICE '  cost of goods   -$%   (avg $%/unit)', r.cogs, r.avg_unit_cost;
    RAISE NOTICE '  = gross profit   $%   ($%/unit, % pct ROI)', r.gross_profit, r.gross_per_unit, r.gross_roi_pct;
    RAISE NOTICE '  returns          %  units (% pct of the % sold)', r.units_returned, r.return_rate_pct, r.units_sold;
    RAISE NOTICE '  cost of returns -$%   ($% each)', r.return_cost,
      round(r.return_cost / NULLIF(r.units_returned, 0), 2);
    RAISE NOTICE '  = NET PROFIT     $%   ($%/unit over all % sold, % pct ROI)',
      r.net_profit, r.net_per_unit, r.units_sold, r.net_roi_pct;
    RAISE NOTICE '  floor if the returns cannot be resold: $% (% pct)',
      r.net_if_written_off, r.roi_if_written_off;
    RAISE NOTICE '  excluded as zero-priced: % rows holding $% of fees',
      r.excluded_zero_rows, r.excluded_zero_fees;
    RAISE NOTICE '';
    RAISE NOTICE '  per KEPT unit (% sold minus % returned = %): $%',
      r.units_sold, r.units_returned, r.units_sold - r.units_returned,
      round(r.net_profit / NULLIF(r.units_sold - r.units_returned, 0), 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== month by month: is 26 pct the normal rate here? ==';
  FOR r IN
    WITH sold AS (
      SELECT date_trunc('month', order_date) AS m, sum(quantity) AS u
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = 'B077DY3DRM' AND order_date >= v_start
        AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
      GROUP BY 1),
    ret AS (
      SELECT date_trunc('month', order_date) AS m,
             sum(CASE WHEN order_id LIKE '%-REFUND'
                      THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                      ELSE COALESCE(refund_quantity, 0) END) AS u
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = 'B077DY3DRM' AND order_date >= v_start
        AND COALESCE(is_cancelled, false) = false
      GROUP BY 1)
    SELECT to_char(COALESCE(s.m, t.m), 'YYYY-MM') AS mon,
           COALESCE(s.u, 0) AS sold, COALESCE(t.u, 0) AS ret,
           round((100.0 * COALESCE(t.u, 0) / NULLIF(s.u, 0))::numeric, 1) AS rate
    FROM sold s FULL JOIN ret t ON t.m = s.m ORDER BY 1
  LOOP
    RAISE NOTICE '  % | sold % | returned % | % pct', r.mon, r.sold, r.ret, COALESCE(r.rate::text, 'n/a');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and what is it? ==';
  FOR r IN SELECT DISTINCT title FROM public.inventory
           WHERE user_id = v_uid AND asin = 'B077DY3DRM' AND title IS NOT NULL LIMIT 1 LOOP
    RAISE NOTICE '  %', left(r.title, 160);
  END LOOP;

  FOR r IN SELECT sku, listing_status, available, reserved, cost, my_price, min_price, max_price
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B077DY3DRM' LOOP
    RAISE NOTICE '  % | % | avail % reserved % | cost $% | price $% | bounds $%/$%',
      r.sku, r.listing_status, r.available, r.reserved, r.cost, r.my_price, r.min_price, r.max_price;
  END LOOP;
END
$p$;
