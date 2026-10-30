-- FEBRUARY: verify the apply from the database, and report every net movement.
--
-- Same checks as July/August/September, plus the full net table at the end so
-- February sits on exactly the same footing as the months applied under the old
-- gate. February is the first month applied under the completeness gate, so the
-- verification carries the weight of showing the gate did not let anything
-- through that the old one would have caught: the fingerprints, the
-- non-adjustment movement count and the clawback reconciliation are unchanged.
DO $p$
DECLARE r record; v_uid uuid; v_claw numeric; v_rows int; v_bad int; v_pairs int;
        v_types_before int; v_types_after int; v_i int := 0;
        v_net numeric := 0; v_unclassified int := 0; v_moved text := '';
        v_m date; v_months date[]; v_mnet numeric; v_mclaw numeric;
        v_unknown int; v_total numeric := 0;
        v_income text[] := ARRAY['sales','reimbursements','shipping_credits',
          'gift_wrap_credits','promotional_rebate_refunds','restocking_fee',
          'other_income','liquidations','warehouse_lost','warehouse_damage',
          'shipping_chargeback_refund'];
        v_exp_neg text[] := ARRAY['referral_fees','fba_fees','fba_customer_return_fees',
          'fba_inbound_fees','fba_inbound_convenience_fee','fba_storage_fees',
          'fba_removal_fees','fba_disposal_fees','fba_long_term_storage_fees',
          'digital_services_fee','other_fees','liquidations_brokerage_fee',
          're_commerce_grading_charge','hrr_non_apparel','compensated_clawback',
          'shipping_chargeback','refunds','shipping_credit_refunds',
          'gift_wrap_credit_refunds','promotional_rebates',
          'marketplace_facilitator_tax','sales_tax_refunds'];
        v_exp_pos text[] := ARRAY['sales_tax_collected','marketplace_facilitator_tax_refunds'];
        -- raw-column classification for the backup-based net table
        v_rincome text[] := ARRAY['sales','reimbursements','reversal_reimbursement',
          'free_replacement_refund_items','shipping_credits','gift_wrap_credits',
          'promotional_rebate_refunds','restocking_fee','other_income','liquidations',
          'warehouse_lost','warehouse_damage','shipping_chargeback_refund',
          'marketplace_facilitator_tax_refunds','sales_tax_collected'];
        v_rexp text[] := ARRAY['referral_fees','fba_fees','fba_customer_return_fees',
          'fba_inbound_fees','fba_inbound_convenience_fee','fba_storage_fees',
          'fba_removal_fees','fba_disposal_fees','fba_long_term_storage_fees',
          'digital_services_fee','other_fees','liquidations_brokerage_fee',
          're_commerce_grading_charge','hrr_non_apparel','shipping_chargeback',
          'refunds','shipping_credit_refunds','gift_wrap_credit_refunds',
          'promotional_rebates','marketplace_facilitator_tax','sales_tax_refunds',
          'fixed_closing_fees','variable_closing_fees'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  WHILE v_i < 10 LOOP
    SELECT COALESCE(sum(compensated_clawback),0) INTO v_claw
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-02-01' AND event_date < '2026-03-01';
    EXIT WHEN round(v_claw,2) <> 0;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  SELECT count(*) INTO v_rows FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-02-01' AND event_date < '2026-03-01';

  RAISE NOTICE '== FEBRUARY after the apply (waited ~% s) ==', v_i*15;
  RAISE NOTICE '   rows % (was 4964) | clawbacks stored % (both runs said -227.95)',
    v_rows, round(v_claw,2);
  IF round(v_claw,2) = 0 THEN
    RAISE NOTICE '   >>> APPLY HAS NOT LANDED -- re-read shortly, nothing is wrong';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. fingerprints, set comparison over whichever types exist ==';
  SELECT count(*) INTO v_types_before FROM public.fec_fingerprint_snapshot
   WHERE snap_month='2026-02-01' AND phase='before';
  v_types_after := public.fec_snapshot_fingerprints(v_uid, '2026-02-01'::date, 'after');
  RAISE NOTICE '   types before % | types after % (February has 39 liquidation rows)',
    v_types_before, v_types_after;
  FOR r IN SELECT * FROM public.fec_compare_fingerprints('2026-02-01'::date)
  LOOP
    RAISE NOTICE '   % | % -> % rows | %',
      rpad(r.event_type,14), lpad(COALESCE(r.rows_before::text,'-'),5),
      lpad(COALESCE(r.rows_after::text,'-'),5), r.verdict;
  END LOOP;
  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-02-01'::date)
   WHERE verdict <> 'identical';
  RAISE NOTICE '   non-identical verdicts: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. clawbacks stored vs the gated figure ==';
  RAISE NOTICE '   stored % | gate -227.95 | match %',
    round(v_claw,2), (round(v_claw,2) = -227.95);

  RAISE NOTICE '';
  RAISE NOTICE '== 3. diff by key, all 57 columns ==';
  SELECT count(*) INTO v_pairs FROM public.fec_diff_month(v_uid,'2026-02-01'::date);
  RAISE NOTICE '   pairs returned % against % live rows -- %', v_pairs, v_rows,
    CASE WHEN v_pairs > v_rows
         THEN 'DUPLICATE KEYS: some pairing arbitrary, trust the aggregate'
         ELSE 'keys unique, pairing exact' END;
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-02-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;
  FOR r IN
    SELECT COALESCE(event_type,'(null)') AS et, verdict, count(*) AS n
    FROM public.fec_diff_month(v_uid,'2026-02-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '      % | % | % rows', rpad(r.et,12), rpad(r.verdict,8), r.n; END LOOP;
  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-02-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  RAISE NOTICE '      non-adjustment rows that moved: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '   clawbacks reconciled across the verdicts:';
  FOR r IN
    SELECT verdict, count(*) AS n,
           round(COALESCE(sum((after_money->>'compensated_clawback')::numeric),0),2) AS claw
    FROM public.fec_diff_month(v_uid,'2026-02-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % rows | clawbacks %',
         rpad(r.verdict,10), lpad(r.n::text,4), lpad(r.claw::text,10); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. every 2026 month: adjustment rows and clawbacks ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw, count(*) AS rows
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % adjustment rows | clawbacks %',
         r.m, lpad(r.rows::text,4), lpad(r.claw::text,10); END LOOP;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- the live P&L would read as zeros';
  END IF;

  CREATE TEMP TABLE feb_live_pl ON COMMIT DROP AS
  SELECT (to_jsonb(l) ->> 'month_num')::integer AS month_num, to_jsonb(l) - 'month_num' AS pl
  FROM public.get_monthly_pl_breakdown(2026) l;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. EVERY moved P&L cell vs the pre-February snapshot ==';
  FOR r IN
    SELECT s.month_num AS m, e.k AS cell,
           round(COALESCE((s.pl ->> e.k)::numeric,0),4) AS was,
           round(COALESCE((l.pl ->> e.k)::numeric,0),4) AS now,
           round(COALESCE((l.pl ->> e.k)::numeric,0)
                 - COALESCE((s.pl ->> e.k)::numeric,0),4) AS delta
    FROM public.pl_snapshot s
    JOIN feb_live_pl l ON l.month_num = s.month_num
    CROSS JOIN LATERAL (
      SELECT DISTINCT key AS k
      FROM (SELECT jsonb_object_keys(s.pl) AS key
            UNION SELECT jsonb_object_keys(l.pl)) u) e
    WHERE s.snap_label = 'pre-2026-02'
      AND COALESCE(s.pl ->> e.k,'~') <> COALESCE(l.pl ->> e.k,'~')
    ORDER BY 1,2
  LOOP
    RAISE NOTICE '   m% % | % -> % | delta % | %',
      lpad(r.m::text,2), rpad(r.cell,28), lpad(r.was::text,12),
      lpad(r.now::text,12), lpad(r.delta::text,10),
      CASE WHEN r.cell = ANY(v_income) THEN 'INCOME  +'
           WHEN r.cell = ANY(v_exp_neg) THEN 'EXPENSE -'
           WHEN r.cell = ANY(v_exp_pos) THEN 'EXPENSE +'
           ELSE 'memo / not in net' END;
    IF v_moved NOT LIKE '%m' || r.m::text || ' %' THEN
      v_moved := v_moved || 'm' || r.m::text || ' ';
    END IF;
    IF r.m = 2 THEN
      IF    r.cell = ANY(v_income)  THEN v_net := v_net + r.delta;
      ELSIF r.cell = ANY(v_exp_neg) THEN v_net := v_net - r.delta;
      ELSIF r.cell = ANY(v_exp_pos) THEN v_net := v_net + r.delta;
      ELSIF r.cell IN ('reversal_reimbursement','free_replacement_refund_items') THEN
        NULL;
      ELSE
        v_unclassified := v_unclassified + 1;
        RAISE NOTICE '      ^^ UNCLASSIFIED -- excluded from the net, check plModel';
      END IF;
    END IF;
  END LOOP;
  RAISE NOTICE '   months that moved since the pre-February snapshot: %',
    COALESCE(NULLIF(v_moved,''),'NONE');

  RAISE NOTICE '';
  RAISE NOTICE '== 6. FEBRUARY NET PROFIT MOVEMENT ==';
  RAISE NOTICE '   clawback line alone    : %', lpad(round(v_claw,2)::text,10);
  RAISE NOTICE '   net of every moved cell: %', lpad(round(v_net,2)::text,10);
  RAISE NOTICE '   unclassified cells excluded: % (must be 0)', v_unclassified;
  IF v_unclassified > 0 THEN
    RAISE EXCEPTION '% moved cell(s) could not be classified -- net incomplete', v_unclassified;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 7. ALL APPLIED MONTHS ON ONE FOOTING, from each months backup ==';
  RAISE NOTICE '   month   | clawback   | other moved | NET PROFIT | unknown cols';
  v_months := ARRAY['2026-01-01','2026-02-01','2026-05-01','2026-06-01',
                    '2026-07-01','2026-08-01','2026-09-01']::date[];
  FOREACH v_m IN ARRAY v_months LOOP
    v_mnet := 0; v_mclaw := 0; v_unknown := 0;
    FOR r IN
      WITH b AS (
        SELECT e.k, sum(e.v::numeric) AS tot
        FROM public.fec_repull_backup t,
             LATERAL jsonb_each_text(to_jsonb(t) - 'backup_month' - 'backed_up_at') AS e(k,v)
        WHERE t.backup_month = v_m AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        GROUP BY 1),
      l AS (
        SELECT e.k, sum(e.v::numeric) AS tot
        FROM public.financial_events_cache t,
             LATERAL jsonb_each_text(to_jsonb(t)) AS e(k,v)
        WHERE t.user_id = v_uid AND t.event_date >= v_m
          AND t.event_date < (v_m + interval '1 month')
          AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        GROUP BY 1)
      SELECT COALESCE(b.k,l.k) AS col,
             round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4) AS delta
      FROM b FULL OUTER JOIN l ON l.k = b.k
      WHERE round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4) <> 0
        AND COALESCE(b.k,l.k) NOT IN ('id','quantity','asin','seller_sku')
    LOOP
      IF r.col = 'compensated_clawback' THEN
        v_mclaw := v_mclaw + r.delta; v_mnet := v_mnet + r.delta;
      ELSIF r.col = ANY(v_rincome) THEN v_mnet := v_mnet + r.delta;
      ELSIF r.col = ANY(v_rexp)    THEN v_mnet := v_mnet - r.delta;
      ELSE
        v_unknown := v_unknown + 1;
        RAISE NOTICE '      % UNKNOWN COLUMN % delta %', to_char(v_m,'YYYY-MM'), r.col, r.delta;
      END IF;
    END LOOP;
    v_total := v_total + v_mnet;
    RAISE NOTICE '   % | % | % | % | %', to_char(v_m,'YYYY-MM'),
      lpad(round(v_mclaw,2)::text,10), lpad(round(v_mnet - v_mclaw,2)::text,11),
      lpad(round(v_mnet,2)::text,10), v_unknown;
  END LOOP;
  RAISE NOTICE '   -----------------------------------------------------------';
  RAISE NOTICE '   TOTAL of the seven applied months: %', lpad(round(v_total,2)::text,10);
  RAISE NOTICE '   still to decide: March (-182.54) and April (-193.44) clawbacks';
  RAISE NOTICE '   October excluded -- its backup predates most of the month';

  RAISE NOTICE '';
  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-02-01'::date)
   WHERE verdict <> 'identical';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'a non-adjustment fingerprint is not identical -- run fec_restore_month';
  END IF;
  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-02-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% non-adjustment row(s) moved -- run fec_restore_month', v_bad;
  END IF;
  IF round(v_claw,2) <> -227.95 THEN
    RAISE EXCEPTION 'stored clawbacks % <> gated -227.95', round(v_claw,2);
  END IF;
  RAISE NOTICE '   ALL CHECKS PASSED';
END
$p$;
