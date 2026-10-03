-- READ-ONLY PROBE. Does get_asin_profit reproduce the hand-verified
-- B0CKJNCZLY numbers? Expected for 2026-01-01..2026-12-31:
--   465 units, revenue 8,428.29, fees 3,885.88, COGS 2,585.40,
--   gross 1,957.01 ($4.21/u), 94 returns at 20.2%, return cost ~587.50,
--   NET ~1,369.51 -> 53.0% ROI.
--
-- The function uses auth.uid(), and a migration runs as the postgres role with
-- no JWT, so it is called here through set_config to impersonate the user --
-- the same way the client will arrive.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);

  RAISE NOTICE '== get_asin_profit(B0CKJNCZLY, 2026) ==';
  FOR r IN SELECT * FROM public.get_asin_profit('B0CKJNCZLY', '2026-01-01', '2026-12-31') LOOP
    RAISE NOTICE '  % | % units in % orders | avg price $% | avg cost $%',
      r.asin, r.units_sold, r.orders, r.avg_sale_price, r.avg_unit_cost;
    RAISE NOTICE '  revenue $% | fees $% | labels $% | COGS $%',
      r.revenue, r.fees, r.label_fees, r.cogs;
    RAISE NOTICE '  GROSS $% ($%/u, % pct ROI)', r.gross_profit, r.gross_per_unit, r.gross_roi_pct;
    RAISE NOTICE '  returns: % units (% pct) costing $%', r.units_returned, r.return_rate_pct, r.return_cost;
    RAISE NOTICE '  NET $% ($%/u) -> % pct ROI', r.net_profit, r.net_per_unit, r.net_roi_pct;
    RAISE NOTICE '  if returns written off: $% -> % pct', r.net_if_written_off, r.roi_if_written_off;
    RAISE NOTICE '  excluded as zero-priced: % rows carrying $% of fees', r.excluded_zero_rows, r.excluded_zero_fees;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== a short window, to prove the dates bite (September only) ==';
  FOR r IN SELECT * FROM public.get_asin_profit('B0CKJNCZLY', '2026-09-01', '2026-09-30') LOOP
    RAISE NOTICE '  % units | revenue $% | NET $% -> % pct | % returns',
      r.units_sold, r.revenue, r.net_profit, r.net_roi_pct, r.units_returned;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== a second ASIN, to prove it generalises (B0G4B3117X, 2026) ==';
  FOR r IN SELECT * FROM public.get_asin_profit('B0G4B3117X', '2026-01-01', '2026-12-31') LOOP
    RAISE NOTICE '  % units | revenue $% | GROSS $% | % returns (% pct) | NET $% -> % pct',
      r.units_sold, r.revenue, r.gross_profit, r.units_returned, r.return_rate_pct,
      r.net_profit, r.net_roi_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== an unknown ASIN returns an empty, not an error ==';
  FOR r IN SELECT * FROM public.get_asin_profit('B000000000', '2026-01-01', '2026-12-31') LOOP
    RAISE NOTICE '  % units | revenue $%', r.units_sold, r.revenue;
  END LOOP;
END
$p$;
