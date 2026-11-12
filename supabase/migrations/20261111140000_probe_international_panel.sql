-- VERIFY the International Marketplace Profit panel. READ ONLY -- SELECTs only.
--
-- The panel (src/components/profitloss/InternationalMarketplaceProfitPanel.tsx)
-- recomputes plModel.ts's taxonomy BY HAND, per marketplace, from
-- get_monthly_pl_breakdown + get_monthly_cogs. Its own header warns that the
-- key lists are a COPY and can fall behind. So this probe does four things:
--
--   A. Recompute the panel's arithmetic and compare to what the seller sees.
--   B. COLUMN COVERAGE -- the real drift test. Enumerate every numeric column
--      in financial_events_cache with a non-zero non-US 2026 total and flag any
--      that appear in NONE of the panel's three key lists. A column nobody
--      mirrored is money the panel silently drops.
--   C. ABS() exposure -- the RPC returns SUM(ABS(col)) for every column, so a
--      stored CREDIT (negative) is handed back as a positive magnitude and then
--      charged. Count negative non-US source values per column.
--   D. COGS integrity -- units missing cost (understates COGS, overstates
--      profit) and the date-basis mismatch (revenue on event_date, COGS on
--      order_date).

DO $p$
DECLARE
  v_uid uuid;
  r record;
  v_income numeric; v_fees numeric; v_cogs numeric;
  v_sql text; v_tot numeric; v_neg bigint;
  v_ti numeric := 0; v_tc numeric := 0; v_tf numeric := 0;
  k_income text[] := ARRAY['sales','reimbursements','shipping_credits','gift_wrap_credits','promotional_rebate_refunds','restocking_fee','other_income','liquidations','warehouse_lost','warehouse_damage','shipping_chargeback_refund'];
  k_deduct text[] := ARRAY['refunds','shipping_credit_refunds','gift_wrap_credit_refunds','promotional_rebates'];
  k_fees   text[] := ARRAY['referral_fees','variable_closing_fees','fixed_closing_fees','fba_fees','fba_customer_return_fees','fba_inbound_fees','fba_inbound_convenience_fee','fba_storage_fees','fba_removal_fees','fba_disposal_fees','fba_long_term_storage_fees','digital_services_fee','other_fees','liquidations_brokerage_fee','re_commerce_grading_charge','hrr_non_apparel','shipping_chargeback','compensated_clawback'];
  -- Deliberately outside the panel: tax sits below Net Profit, the two
  -- reimbursement subtypes are already merged into `reimbursements` by the RPC,
  -- and fbm_shipping_label_fee has never held a non-zero value.
  k_ok_out text[] := ARRAY['sales_tax_collected','marketplace_facilitator_tax','sales_tax_refunds','marketplace_facilitator_tax_refunds','reversal_reimbursement','free_replacement_refund_items','fbm_shipping_label_fee'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  RAISE NOTICE '=== A. PANEL ARITHMETIC, 2026 ===';
  RAISE NOTICE 'mp |       sales |        COGS |        fees |      profit';
  FOR r IN SELECT unnest(ARRAY['CA','MX','BR']) AS mp LOOP
    SELECT
      SUM(p.sales + p.reimbursements + p.shipping_credits + p.gift_wrap_credits
          + p.promotional_rebate_refunds + p.restocking_fee + p.other_income
          + p.liquidations + p.warehouse_lost + p.warehouse_damage
          + p.shipping_chargeback_refund
          - p.refunds - p.shipping_credit_refunds - p.gift_wrap_credit_refunds
          - p.promotional_rebates),
      SUM(p.referral_fees + p.variable_closing_fees + p.fixed_closing_fees
          + p.fba_fees + p.fba_customer_return_fees + p.fba_inbound_fees
          + p.fba_inbound_convenience_fee + p.fba_storage_fees
          + p.fba_removal_fees + p.fba_disposal_fees
          + p.fba_long_term_storage_fees + p.digital_services_fee
          + p.other_fees + p.liquidations_brokerage_fee
          + p.re_commerce_grading_charge + p.hrr_non_apparel
          + p.shipping_chargeback + p.compensated_clawback)
    INTO v_income, v_fees
    FROM public.get_monthly_pl_breakdown(2026, r.mp) p;

    SELECT COALESCE(SUM(c.cogs), 0) INTO v_cogs
    FROM public.get_monthly_cogs(2026, r.mp) c;

    v_ti := v_ti + v_income; v_tc := v_tc + v_cogs; v_tf := v_tf + v_fees;
    RAISE NOTICE '% | % | % | % | %', r.mp,
      lpad(to_char(v_income,'FM999999990.00'),11),
      lpad(to_char(v_cogs,'FM999999990.00'),11),
      lpad(to_char(v_fees,'FM999999990.00'),11),
      lpad(to_char(v_income - v_cogs - v_fees,'FM999999990.00'),11);
  END LOOP;
  RAISE NOTICE 'TOTAL %  %  %  profit %',
    to_char(v_ti,'FM999999990.00'), to_char(v_tc,'FM999999990.00'),
    to_char(v_tf,'FM999999990.00'), to_char(v_ti - v_tc - v_tf,'FM999999990.00');

  RAISE NOTICE ' ';
  RAISE NOTICE '=== B. COLUMN COVERAGE: non-US 2026 columns the panel ignores ===';
  FOR r IN
    SELECT column_name AS c
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'financial_events_cache'
      AND data_type IN ('numeric','double precision','real','integer','bigint')
      AND column_name NOT IN ('id','user_id','quantity')
    ORDER BY column_name
  LOOP
    v_sql := format(
      'SELECT COALESCE(SUM(%I),0), COUNT(*) FILTER (WHERE %I < 0) FROM public.financial_events_cache
         WHERE user_id = %L AND event_date::date >= ''2026-01-01'' AND event_date::date < ''2027-01-01''
           AND UPPER(COALESCE(marketplace,'''')) IN (''CA'',''MX'',''BR'')',
      r.c, r.c, v_uid);
    EXECUTE v_sql INTO v_tot, v_neg;
    IF COALESCE(v_tot,0) <> 0 OR COALESCE(v_neg,0) > 0 THEN
      IF r.c = ANY(k_income) THEN
        NULL; -- counted as income
      ELSIF r.c = ANY(k_deduct) OR r.c = ANY(k_fees) THEN
        NULL; -- counted as a cost
      ELSIF r.c = ANY(k_ok_out) THEN
        RAISE NOTICE 'excluded-on-purpose %  total % (neg rows %)', rpad(r.c,34), to_char(v_tot,'FM999999990.00'), v_neg;
      ELSE
        RAISE NOTICE '*** NOT MIRRORED ANYWHERE *** %  total % (neg rows %)', rpad(r.c,30), to_char(v_tot,'FM999999990.00'), v_neg;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== C. ABS() EXPOSURE: negative (credit) non-US values per column ===';
  FOR r IN
    SELECT column_name AS c
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'financial_events_cache'
      AND data_type IN ('numeric','double precision','real')
      AND column_name = ANY(k_income || k_deduct || k_fees)
    ORDER BY column_name
  LOOP
    v_sql := format(
      'SELECT COUNT(*) FILTER (WHERE %I < 0), COALESCE(SUM(%I) FILTER (WHERE %I < 0),0)
         FROM public.financial_events_cache
         WHERE user_id = %L AND event_date::date >= ''2026-01-01'' AND event_date::date < ''2027-01-01''
           AND UPPER(COALESCE(marketplace,'''')) IN (''CA'',''MX'',''BR'')',
      r.c, r.c, r.c, v_uid);
    EXECUTE v_sql INTO v_neg, v_tot;
    IF COALESCE(v_neg,0) > 0 THEN
      RAISE NOTICE 'negatives: % rows % sum %', rpad(r.c,34), lpad(v_neg::text,5), to_char(v_tot,'FM999999990.00');
    END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== D. COGS INTEGRITY, non-US 2026 ===';
  FOR r IN SELECT unnest(ARRAY['CA','MX','BR']) AS mp LOOP
    FOR v_sql IN
      SELECT format('%s units %s, with cost %s, MISSING cost %s, orders missing %s',
                    r.mp, SUM(c.units_sold), SUM(c.units_with_cost),
                    SUM(c.units_missing_cost), SUM(c.orders_missing_cost))
      FROM public.get_monthly_cogs(2026, r.mp) c
    LOOP RAISE NOTICE '%', v_sql; END LOOP;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== D2. DATE BASIS: non-US shipment events whose event_date year <> order year ===';
  FOR r IN
    SELECT UPPER(f.marketplace) AS mp,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM f.event_date::date) <> EXTRACT(YEAR FROM s.order_date)) AS crossing
    FROM public.financial_events_cache f
    JOIN public.sales_orders s ON s.user_id = f.user_id AND s.order_id = f.amazon_order_id
    WHERE f.user_id = v_uid AND f.event_type = 'shipment'
      AND UPPER(COALESCE(f.marketplace,'')) IN ('CA','MX','BR')
      AND f.event_date::date >= '2026-01-01' AND f.event_date::date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '% matched % events, % cross a year boundary', r.mp, r.n, r.crossing;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== D3. "Data through": newest event ALL-TIME vs newest in 2026 ===';
  FOR r IN
    SELECT UPPER(marketplace) AS mp,
           MAX(event_date::date) AS newest_all,
           MAX(event_date::date) FILTER (WHERE event_date::date < '2027-01-01'
                                           AND event_date::date >= '2026-01-01') AS newest_2026
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND UPPER(COALESCE(marketplace,'')) IN ('CA','MX','BR')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '% newest all-time %, newest in 2026 %', r.mp, r.newest_all, r.newest_2026;
  END LOOP;
END $p$;
