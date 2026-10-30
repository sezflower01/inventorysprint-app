-- SEPTEMBER: verify the apply from the database.
--
-- Same seven checks as August. Two notes carried forward:
--
--   * All 85 September adjustment rows carry NO asin, and fec_diff_month joins
--     on (event_type, event_date, amazon_order_id, asin). Once the re-pull has
--     replaced those rows, several can share one key and pair arbitrarily --
--     that is what produced August's 8 spurious CHANGED rows. So the pair count
--     is printed against the row count: pairs > rows means the pairing is
--     ambiguous and only the aggregates are meaningful for those rows.
--
--   * The net profit movement is NOT the clawback total. July moved four P&L
--     cells and August four, the extras being reimbursement income carried on
--     the same adjustment rows. Every moved cell is classified against
--     plModel's INCOME_ROWS/EXPENSE_ROWS and an unclassified one fails the
--     check rather than being dropped from the total.
DO $p$
DECLARE r record; v_uid uuid; v_claw numeric; v_rows int; v_bad int; v_pairs int;
        v_types_before int; v_types_after int; v_i int := 0;
        v_net numeric := 0; v_unclassified int := 0; v_moved text := '';
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
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  WHILE v_i < 10 LOOP
    SELECT COALESCE(sum(compensated_clawback),0) INTO v_claw
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-09-01' AND event_date < '2026-10-01';
    EXIT WHEN round(v_claw,2) <> 0;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  SELECT count(*) INTO v_rows FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-09-01' AND event_date < '2026-10-01';

  RAISE NOTICE '== SEPTEMBER after the apply (waited ~% s) ==', v_i*15;
  RAISE NOTICE '   rows % (was 3446) | clawbacks stored % (API said -213.20)',
    v_rows, round(v_claw,2);
  IF round(v_claw,2) = 0 THEN
    RAISE NOTICE '   >>> APPLY HAS NOT LANDED -- re-read shortly, nothing is wrong';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. fingerprints, set comparison over whichever types exist ==';
  SELECT count(*) INTO v_types_before FROM public.fec_fingerprint_snapshot
   WHERE snap_month='2026-09-01' AND phase='before';
  v_types_after := public.fec_snapshot_fingerprints(v_uid, '2026-09-01'::date, 'after');
  RAISE NOTICE '   types before % | types after %', v_types_before, v_types_after;
  FOR r IN SELECT * FROM public.fec_compare_fingerprints('2026-09-01'::date)
  LOOP
    RAISE NOTICE '   % | % -> % rows | %',
      rpad(r.event_type,14), lpad(COALESCE(r.rows_before::text,'-'),5),
      lpad(COALESCE(r.rows_after::text,'-'),5), r.verdict;
  END LOOP;
  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-09-01'::date)
   WHERE verdict <> 'identical';
  RAISE NOTICE '   non-identical verdicts: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. clawbacks stored vs API ==';
  RAISE NOTICE '   stored % | API -213.20 | match %',
    round(v_claw,2), (round(v_claw,2) = -213.20);

  RAISE NOTICE '';
  RAISE NOTICE '== 3. diff by key, all 57 columns ==';
  SELECT count(*) INTO v_pairs FROM public.fec_diff_month(v_uid,'2026-09-01'::date);
  RAISE NOTICE '   pairs returned % against % live rows -- %', v_pairs, v_rows,
    CASE WHEN v_pairs > v_rows
         THEN 'DUPLICATE KEYS: some pairing is arbitrary, trust the aggregate'
         ELSE 'keys unique, pairing is exact' END;
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-09-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  RAISE NOTICE '   is every non-unchanged row an adjustment?';
  FOR r IN
    SELECT COALESCE(event_type,'(null)') AS et, verdict, count(*) AS n
    FROM public.fec_diff_month(v_uid,'2026-09-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '      % | % | % rows', rpad(r.et,12), rpad(r.verdict,8), r.n; END LOOP;
  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-09-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  RAISE NOTICE '      non-adjustment rows that moved: % (must be 0)', v_bad;

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

  RAISE NOTICE '';
  RAISE NOTICE '== 5. unpaired amounts, by key ==';
  FOR r IN
    SELECT verdict, count(*) AS n,
           round(COALESCE(sum((after_money->>'compensated_clawback')::numeric),0),2) AS claw
    FROM public.fec_diff_month(v_uid,'2026-09-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows | clawbacks in them %',
         rpad(r.verdict,10), lpad(r.n::text,4), lpad(r.claw::text,10); END LOOP;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- the live P&L would read as zeros';
  END IF;

  CREATE TEMP TABLE sep_live_pl ON COMMIT DROP AS
  SELECT (to_jsonb(l) ->> 'month_num')::integer AS month_num, to_jsonb(l) - 'month_num' AS pl
  FROM public.get_monthly_pl_breakdown(2026) l;

  RAISE NOTICE '';
  RAISE NOTICE '== 6a. EVERY moved P&L cell vs the pre-September snapshot ==';
  FOR r IN
    SELECT s.month_num AS m, e.k AS cell,
           round(COALESCE((s.pl ->> e.k)::numeric,0),4) AS was,
           round(COALESCE((l.pl ->> e.k)::numeric,0),4) AS now,
           round(COALESCE((l.pl ->> e.k)::numeric,0)
                 - COALESCE((s.pl ->> e.k)::numeric,0),4) AS delta
    FROM public.pl_snapshot s
    JOIN sep_live_pl l ON l.month_num = s.month_num
    CROSS JOIN LATERAL (
      SELECT DISTINCT key AS k
      FROM (SELECT jsonb_object_keys(s.pl) AS key
            UNION SELECT jsonb_object_keys(l.pl)) u) e
    WHERE s.snap_label = 'pre-2026-09'
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

    IF r.m = 9 THEN
      IF    r.cell = ANY(v_income)  THEN v_net := v_net + r.delta;
      ELSIF r.cell = ANY(v_exp_neg) THEN v_net := v_net - r.delta;
      ELSIF r.cell = ANY(v_exp_pos) THEN v_net := v_net + r.delta;
      ELSIF r.cell IN ('reversal_reimbursement','free_replacement_refund_items') THEN
        NULL;  -- subtypes already inside the merged reimbursements line
      ELSE
        v_unclassified := v_unclassified + 1;
        RAISE NOTICE '      ^^ UNCLASSIFIED -- excluded from the net, check plModel';
      END IF;
    END IF;
  END LOOP;
  RAISE NOTICE '   months that moved since the pre-September snapshot: %',
    COALESCE(NULLIF(v_moved,''),'NONE');

  RAISE NOTICE '';
  RAISE NOTICE '== 6b. cumulative: every moved cell vs pl_baseline_20261030 ==';
  FOR r IN
    SELECT b.month_num AS m, e.k AS cell,
           round(COALESCE((b.pl ->> e.k)::numeric,0),4) AS was,
           round(COALESCE((l.pl ->> e.k)::numeric,0),4) AS now
    FROM public.pl_baseline_20261030 b
    JOIN sep_live_pl l ON l.month_num = b.month_num
    CROSS JOIN LATERAL (
      SELECT DISTINCT key AS k
      FROM (SELECT jsonb_object_keys(b.pl) AS key
            UNION SELECT jsonb_object_keys(l.pl)) u) e
    WHERE COALESCE(b.pl ->> e.k,'~') <> COALESCE(l.pl ->> e.k,'~')
    ORDER BY 1,2
  LOOP
    RAISE NOTICE '   m% % | % -> %', lpad(r.m::text,2), rpad(r.cell,28),
      lpad(r.was::text,12), lpad(r.now::text,12);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 7. SEPTEMBER NET PROFIT MOVEMENT ==';
  RAISE NOTICE '   clawback line alone    : %', lpad(round(v_claw,2)::text,10);
  RAISE NOTICE '   net of every moved cell: %', lpad(round(v_net,2)::text,10);
  RAISE NOTICE '   unclassified cells excluded: % (must be 0)', v_unclassified;
  IF v_unclassified > 0 THEN
    RAISE EXCEPTION '% moved cell(s) could not be classified -- the net is incomplete',
      v_unclassified;
  END IF;

  RAISE NOTICE '';
  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-09-01'::date)
   WHERE verdict <> 'identical';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'a non-adjustment fingerprint is not identical -- run fec_restore_month';
  END IF;
  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-09-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% non-adjustment row(s) moved -- run fec_restore_month', v_bad;
  END IF;
  IF round(v_claw,2) <> -213.20 THEN
    RAISE EXCEPTION 'stored clawbacks % <> API -213.20', round(v_claw,2);
  END IF;
  RAISE NOTICE '   ALL CHECKS PASSED';
END
$p$;
