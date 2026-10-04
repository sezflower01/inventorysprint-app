-- READ-ONLY PROBE. The create extension shows "Last 12 months: 501 sold · net
-- $1695.74 · ROI 61% · 97 returned (19.4%)" while the Sales Report showed 465
-- sold / $1,369.18 / 53.0% / 94 returned for calendar 2026.
--
-- Both can be right: the extension asks for a ROLLING twelve months, which
-- reaches back into late 2025, and 2025 sold at higher prices. Reproduce the
-- extension's exact window to confirm, and show the overlap so the difference
-- is attributable rather than merely plausible.

DO $p$
DECLARE v_uid uuid; r record; v_start date; v_end date;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);

  -- the same window background.js computes: today minus 12 months, to today
  v_end := current_date;
  v_start := (date_trunc('day', current_date) - interval '12 months')::date;
  RAISE NOTICE 'extension window: % .. %', v_start, v_end;

  FOR r IN SELECT * FROM public.get_asin_profit('B0CKJNCZLY', v_start, v_end) LOOP
    RAISE NOTICE '  % sold in % orders | revenue $% | fees $% | COGS $%',
      r.units_sold, r.orders, r.revenue, r.fees, r.cogs;
    RAISE NOTICE '  gross $% | % returns (% pct) cost $%',
      r.gross_profit, r.units_returned, r.return_rate_pct, r.return_cost;
    RAISE NOTICE '  NET $% -> % pct ROI | avg price $%', r.net_profit, r.net_roi_pct, r.avg_sale_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== calendar 2026, for comparison ==';
  FOR r IN SELECT * FROM public.get_asin_profit('B0CKJNCZLY', '2026-01-01', '2026-12-31') LOOP
    RAISE NOTICE '  % sold | NET $% -> % pct | avg price $%',
      r.units_sold, r.net_profit, r.net_roi_pct, r.avg_sale_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the extra slice: 2025-10-03 .. 2025-12-31 ==';
  FOR r IN SELECT * FROM public.get_asin_profit('B0CKJNCZLY', v_start, '2025-12-31') LOOP
    RAISE NOTICE '  % sold | revenue $% | NET $% -> % pct | avg price $%',
      r.units_sold, r.revenue, r.net_profit, r.net_roi_pct, r.avg_sale_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and which SKU is 0SL-UCQ-PYLO? ==';
  FOR r IN SELECT DISTINCT sku, asin FROM public.sales_orders
           WHERE user_id = v_uid AND sku = '0SL-UCQ-PYLO' LIMIT 3 LOOP
    RAISE NOTICE '  sales: sku % -> asin %', r.sku, r.asin;
  END LOOP;
  FOR r IN SELECT sku, asin, listing_status, available FROM public.inventory
           WHERE user_id = v_uid AND sku = '0SL-UCQ-PYLO' LIMIT 3 LOOP
    RAISE NOTICE '  inventory: sku % -> asin % (% , % units)', r.sku, r.asin, r.listing_status, r.available;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (SKU not in inventory yet — a new SKU being created)'; END IF;
END
$p$;
