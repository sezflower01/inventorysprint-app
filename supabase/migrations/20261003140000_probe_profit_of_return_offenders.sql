-- READ-ONLY PROBE. Run get_asin_profit over the worst return offenders: a high
-- return rate only matters if it is eating the profit, and these are the ASINs
-- where it might be.
--
-- Note on rates above 100% (B08HGZ2HXT shows 75 returned against 61 sold): a
-- return is dated when Amazon processes it, so units sold in late 2025 can be
-- returned inside a 2026 window. The rate is therefore not a per-unit
-- probability for that ASIN -- it is returns-in-period over sales-in-period, and
-- for slow movers with a long return tail the two do not line up. The profit
-- figure is still right, because it charges the returns it can see.

DO $p$
DECLARE v_uid uuid; a text; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);

  FOREACH a IN ARRAY ARRAY['B0CYR1KRRL','B08HGZ2HXT','B077ZYJ3TB','B00ZQFTTJC',
                           'B08YJW5G1R','B000GWG14Q','B077DY3DRM','B01BPX8BLK',
                           'B09WJHD19B','B0002KR11O','B0CKJNCZLY']
  LOOP
    FOR r IN SELECT * FROM public.get_asin_profit(a, '2026-01-01', '2026-12-31') LOOP
      RAISE NOTICE '% | % units | rev $% | gross $% (% pct) | % ret (% pct) cost $% | NET $% (% pct) | floor $% (% pct)',
        r.asin, r.units_sold, r.revenue, r.gross_profit, r.gross_roi_pct,
        r.units_returned, r.return_rate_pct, r.return_cost,
        r.net_profit, r.net_roi_pct, r.net_if_written_off, r.roi_if_written_off;
    END LOOP;
  END LOOP;
END
$p$;
