-- READ-ONLY. The two overloads disagree on referral_fees by $10,396.78 for
-- Jan 1 to today, and therefore on total_expenses by the same amount. The app
-- calls the 3-arg version everywhere (ProfitLoss.tsx:463,
-- MonthlyPLBreakdown.tsx:363, InternationalMarketplaceProfitPanel.tsx:75), so
-- the screen currently shows the LOWER expense figure and a Net Profit
-- $10,396.78 higher than the other overload would give.
--
-- financial_events_cache is the source both read. Sum it directly and see
-- which one it agrees with.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== raw referral_fees from the source table, Jan 1 to today ==';
  FOR r IN
    SELECT count(*) AS rows,
           round(sum(referral_fees)::numeric,2) AS all_rows,
           round(sum(referral_fees) FILTER (WHERE COALESCE(marketplace,'US')='US')::numeric,2) AS us_only,
           round(sum(referral_fees) FILTER (WHERE COALESCE(marketplace,'US')<>'US')::numeric,2) AS non_us
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01'
  LOOP
    RAISE NOTICE '  % rows | all $% | US $% | non-US $%',
      r.rows, r.all_rows, r.us_only, r.non_us;
    RAISE NOTICE '  2-arg overload said $137323.78 | 3-arg said $126926.99 | gap $10396.78';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== by marketplace, so the gap can be attributed ==';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mk, count(*) AS rows,
           round(sum(referral_fees)::numeric,2) AS referral
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01'
    GROUP BY 1 ORDER BY referral DESC NULLS LAST
  LOOP
    RAISE NOTICE '  % | % rows | $%', rpad(r.mk,10), lpad(r.rows::text,7), r.referral;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does the 3-arg version treat ALL as a filter rather than no filter? ==';
  FOR r IN
    SELECT round(referral_fees::numeric,2) AS referral, round(total_expenses::numeric,2) AS expenses
    FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text, 'US')
  LOOP
    RAISE NOTICE '  3-arg with US  : referral $% | expenses $%', r.referral, r.expenses;
  END LOOP;
  FOR r IN
    SELECT round(referral_fees::numeric,2) AS referral, round(total_expenses::numeric,2) AS expenses
    FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text, 'ALL')
  LOOP
    RAISE NOTICE '  3-arg with ALL : referral $% | expenses $%', r.referral, r.expenses;
  END LOOP;
  FOR r IN
    SELECT round(referral_fees::numeric,2) AS referral, round(total_expenses::numeric,2) AS expenses
    FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text)
  LOOP
    RAISE NOTICE '  2-arg          : referral $% | expenses $%', r.referral, r.expenses;
  END LOOP;
END
$p$;
