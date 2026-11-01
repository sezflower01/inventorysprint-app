-- TAX READINESS: can the 2026 P&L be reconciled to Amazon's actual deposits?
-- READ ONLY. 2026 only. Nothing written, no API called.
--
-- ── WHY THIS AND NOT THE PHASE QUEUE ─────────────────────────────────
--
-- The remaining phases (3-6) are display bugs, an ingest field and two small
-- cleanups. None of them is what makes a P&L filable. What does is being able
-- to tie the report to money that actually arrived in the bank, because that
-- is the reconciliation an accountant asks for and the one thing this app has
-- never been shown to do.
--
-- It is also the only item on a CLOCK. Amazon retains settlement reports for
-- about 90 days; once a period ages out it cannot be re-fetched. So if 2026's
-- early settlements were never captured, that is already permanent, and every
-- further week loses another period. Finding that out is urgent in a way the
-- phase queue is not.
--
-- ── WHAT A DEPOSIT IS AND IS NOT ─────────────────────────────────────
--
-- Settlement deposits are CASH: sales minus Amazon's fees minus refunds, for a
-- settlement period, paid on deposit_date. They are NOT net profit. They
-- exclude COGS entirely, exclude operating expenses, and are timing-shifted
-- against order dates. So a deposit total will never equal a P&L net profit,
-- and any report claiming it should is wrong. What CAN be reconciled is the
-- Amazon-payout subtotal: P&L income minus the Amazon fee and refund lines,
-- before COGS and opex. That is what is computed below, and the residual is
-- reported as a residual rather than explained away.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_reports int; v_parsed int; v_deposits numeric;
  v_pl_payout numeric := 0; v_li_rows bigint;
  v_min date; v_max date; v_gap int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. WHAT SETTLEMENT DATA EXISTS AT ALL ########';
  SELECT count(*), count(*) FILTER (WHERE status = 'parsed'),
         min(settlement_start_date), max(settlement_end_date)
    INTO v_reports, v_parsed, v_min, v_max
  FROM public.settlement_reports WHERE user_id = v_uid;
  RAISE NOTICE '   settlement_reports rows : % (% parsed)', v_reports, v_parsed;
  RAISE NOTICE '   period coverage         : % .. %', v_min, v_max;
  SELECT count(*) INTO v_li_rows FROM public.settlement_line_items
   WHERE user_id = v_uid;
  RAISE NOTICE '   settlement_line_items   : % rows', v_li_rows;

  IF v_reports = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> NO SETTLEMENT DATA AT ALL. The P&L cannot be tied to a';
    RAISE NOTICE '   >>> deposit, and 2026''s periods are past Amazon''s ~90-day';
    RAISE NOTICE '   >>> retention, so most of the year is unrecoverable from';
    RAISE NOTICE '   >>> the API. The fallback is Seller Central''s own';
    RAISE NOTICE '   >>> settlement report downloads, which go back further.';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   by status:';
  FOR r IN
    SELECT COALESCE(status,'(null)') AS st, count(*) AS n,
           round(sum(COALESCE(total_amount,0)),2) AS amt
    FROM public.settlement_reports WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '      % | % reports | % total', rpad(r.st,12), r.n, r.amt;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. 2026 COVERAGE, MONTH BY MONTH ########';
  RAISE NOTICE '   Amazon settles roughly every 14 days, so a complete month';
  RAISE NOTICE '   should show 2 or 3 periods. Fewer means a gap.';
  RAISE NOTICE '   month   | periods | deposits    | first .. last';
  FOR r IN
    SELECT to_char(date_trunc('month', settlement_end_date),'YYYY-MM') AS mo,
           count(*) AS n,
           round(sum(COALESCE(total_amount,0)),2) AS amt,
           min(settlement_start_date) AS f, max(settlement_end_date) AS l
    FROM public.settlement_reports
    WHERE user_id = v_uid
      AND settlement_end_date >= '2026-01-01'
      AND settlement_end_date <  '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | % .. %', r.mo, lpad(r.n::text,7),
      lpad(r.amt::text,11), r.f, r.l;
    IF r.n < 2 THEN v_gap := v_gap + 1; END IF;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE for 2026 -- every stored period is outside the year.';
  END IF;
  RAISE NOTICE '   months with fewer than 2 periods (likely incomplete): %', v_gap;

  SELECT round(sum(COALESCE(total_amount,0)),2) INTO v_deposits
  FROM public.settlement_reports
  WHERE user_id = v_uid
    AND settlement_end_date >= '2026-01-01' AND settlement_end_date < '2027-01-01';
  RAISE NOTICE '   2026 deposits on file: %', COALESCE(v_deposits,0);

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. THE P&L''S IMPLIED AMAZON PAYOUT ########';
  RAISE NOTICE '   income lines minus Amazon fee/refund lines, BEFORE COGS and';
  RAISE NOTICE '   operating expenses -- the subtotal a deposit can be compared';
  RAISE NOTICE '   to. Sales tax is excluded: Amazon remits it, it is not ours.';
  FOR r IN
    SELECT
      round(sum(sales + reimbursements + shipping_credits + gift_wrap_credits
                + promotional_rebate_refunds + restocking_fee + other_income
                + liquidations + warehouse_lost + warehouse_damage
                + shipping_chargeback_refund),2) AS income,
      round(sum(referral_fees + fba_fees + variable_closing_fees
                + fixed_closing_fees + fba_inbound_fees + fba_storage_fees
                + fba_removal_fees + fba_disposal_fees
                + fba_long_term_storage_fees + fba_customer_return_fees
                + digital_services_fee + fba_inbound_convenience_fee
                + other_fees + liquidations_brokerage_fee
                + re_commerce_grading_charge + compensated_clawback
                + hrr_non_apparel + shipping_chargeback + refunds
                + shipping_credit_refunds + gift_wrap_credit_refunds
                + promotional_rebates),2) AS fees
    FROM public.get_monthly_pl_breakdown(2026, NULL)
  LOOP
    v_pl_payout := COALESCE(r.income,0) - COALESCE(r.fees,0);
    RAISE NOTICE '   P&L income (ex sales tax) : %', r.income;
    RAISE NOTICE '   P&L Amazon fees + refunds : %', r.fees;
    RAISE NOTICE '   implied payout            : %', round(v_pl_payout,2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   deposits on file          : %', COALESCE(v_deposits,0);
  RAISE NOTICE '   RESIDUAL                  : %',
    round(COALESCE(v_deposits,0) - v_pl_payout,2);
  RAISE NOTICE '';
  RAISE NOTICE '   The residual is NOT an error on its own. It absorbs, at';
  RAISE NOTICE '   least: settlement periods straddling 1 Jan and 31 Dec;';
  RAISE NOTICE '   periods missing from the table; marketplace facilitator tax';
  RAISE NOTICE '   that appears in settlements but not in Financial Events';
  RAISE NOTICE '   (see the facilitator-tax finding); FBM label costs that';
  RAISE NOTICE '   Amazon never sends as financial events; and any deposit';
  RAISE NOTICE '   Amazon withheld as a reserve. It becomes a FINDING only';
  RAISE NOTICE '   after those are accounted for, which needs the missing';
  RAISE NOTICE '   periods first.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. WHAT IS ALREADY UNRECOVERABLE ########';
  RAISE NOTICE '   Amazon retains settlement reports ~90 days. Today is';
  RAISE NOTICE '   2026-11-01, so anything ending before about 2026-08-03 can';
  RAISE NOTICE '   no longer be fetched from the API.';
  FOR r IN
    SELECT count(*) FILTER (WHERE settlement_end_date < current_date - 90) AS past,
           count(*) FILTER (WHERE settlement_end_date >= current_date - 90) AS fresh
    FROM public.settlement_reports
    WHERE user_id = v_uid AND settlement_end_date >= '2026-01-01'
  LOOP
    RAISE NOTICE '   2026 periods on file older than 90 days : % (safe -- already captured)',
      r.past;
    RAISE NOTICE '   2026 periods on file inside the window  : %', r.fresh;
  END LOOP;
  RAISE NOTICE '   The risk is periods NOT on file and older than 90 days:';
  RAISE NOTICE '   those are gone from the API and must come from Seller';
  RAISE NOTICE '   Central''s own report download instead.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 5. CONTROLS ########';
  FOR r IN
    SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) AS claw
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP
    RAISE NOTICE '   clawback % | % | nine-month NET -1765.91', r.claw,
      CASE WHEN r.claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END;
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
