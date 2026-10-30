-- READ-ONLY. The two tables needed to decide what happens next.
--
-- A. Net profit movement per applied month, all on one footing, computed from
--    each month's own backup rather than from the P&L -- Jan, May and June were
--    applied before a usable baseline existed, so the backup is the only
--    common measure across all of them.
--
--    THE SIGN TRAP: compensated_clawback is stored NEGATIVE and the RPC ABSes
--    it into an expense magnitude, so in raw-column terms its delta IS the
--    profit effect and is ADDED. Every other expense column is stored as a
--    positive magnitude and must be SUBTRACTED. Reversed, the clawback doubles.
--
--    Income counts reimbursements, reversal_reimbursement AND
--    free_replacement_refund_items, because the P&L's Reimbursements line is
--    the merge of all three.
--
-- B. Every stored Feb/Mar/Apr dry run, for the completeness-gate decision.
--    Those three cannot pass a zero-hits gate -- they hit the throttle on some
--    runs -- so the question is whether agreement between two runs on items,
--    pages, clawbacks and signed total is a sound substitute. The distinct-value
--    counts are the evidence for that, not the hit counts.
DO $p$
DECLARE r record; v_uid uuid; v_m date; v_months date[];
        v_net numeric; v_claw numeric; v_unknown int; v_total numeric := 0;
        v_income text[] := ARRAY['sales','reimbursements','reversal_reimbursement',
          'free_replacement_refund_items','shipping_credits','gift_wrap_credits',
          'promotional_rebate_refunds','restocking_fee','other_income','liquidations',
          'warehouse_lost','warehouse_damage','shipping_chargeback_refund',
          'marketplace_facilitator_tax_refunds','sales_tax_collected'];
        v_exp text[] := ARRAY['referral_fees','fba_fees','fba_customer_return_fees',
          'fba_inbound_fees','fba_inbound_convenience_fee','fba_storage_fees',
          'fba_removal_fees','fba_disposal_fees','fba_long_term_storage_fees',
          'digital_services_fee','other_fees','liquidations_brokerage_fee',
          're_commerce_grading_charge','hrr_non_apparel','shipping_chargeback',
          'refunds','shipping_credit_refunds','gift_wrap_credit_refunds',
          'promotional_rebates','marketplace_facilitator_tax','sales_tax_refunds',
          'fixed_closing_fees','variable_closing_fees'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '############ A. NET PROFIT MOVEMENT PER APPLIED MONTH ############';
  RAISE NOTICE '   month   | clawback   | other moved | NET PROFIT | unknown cols';
  v_months := ARRAY['2026-01-01','2026-05-01','2026-06-01','2026-07-01',
                    '2026-08-01','2026-09-01']::date[];
  FOREACH v_m IN ARRAY v_months LOOP
    v_net := 0; v_claw := 0; v_unknown := 0;
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
        v_claw := v_claw + r.delta;
        v_net  := v_net  + r.delta;
      ELSIF r.col = ANY(v_income) THEN v_net := v_net + r.delta;
      ELSIF r.col = ANY(v_exp)    THEN v_net := v_net - r.delta;
      ELSE
        v_unknown := v_unknown + 1;
        RAISE NOTICE '      % UNKNOWN COLUMN % delta % -- excluded',
          to_char(v_m,'YYYY-MM'), r.col, r.delta;
      END IF;
    END LOOP;
    v_total := v_total + v_net;
    RAISE NOTICE '   % | % | % | % | %', to_char(v_m,'YYYY-MM'),
      lpad(round(v_claw,2)::text,10), lpad(round(v_net - v_claw,2)::text,11),
      lpad(round(v_net,2)::text,10), v_unknown;
  END LOOP;
  RAISE NOTICE '   -----------------------------------------------------------';
  RAISE NOTICE '   TOTAL of the six applied months: %', lpad(round(v_total,2)::text,10);
  RAISE NOTICE '';
  RAISE NOTICE '   October excluded: its backup was taken 10-22 with the month';
  RAISE NOTICE '   part-grown (3,286 rows against 4,551 now), so a backup-vs-live';
  RAISE NOTICE '   delta there measures the month continuing, not the re-pull.';
  RAISE NOTICE '   Its clawback total also still moves as Amazon posts.';

  RAISE NOTICE '';
  RAISE NOTICE '############ B. FEB / MAR / APR: EVERY STORED DRY RUN ############';
  RAISE NOTICE '   month   captured           hits  pages  items   clawbacks     signed';
  FOR r IN
    SELECT left(rr.month,7) AS mon, to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t,
           rr.report->>'rate_limit_hits'    AS hits,
           rr.report->>'pages'              AS pages,
           rr.report->>'api_items'          AS items,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) IN ('2026-02','2026-03','2026-04')
      AND rr.report ? 'api_signed_total'
    ORDER BY left(rr.month,7), rr.captured_at
  LOOP
    RAISE NOTICE '   % %  % % %  % %', r.mon, r.t,
      lpad(COALESCE(r.hits,'-'),4), lpad(COALESCE(r.pages,'-'),6),
      lpad(COALESCE(r.items,'-'),6), lpad(COALESCE(r.claw,'-'),11),
      lpad(COALESCE(r.signed,'-'),10);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   -- the completeness question: does the DATA ever move? --';
  FOR r IN
    SELECT left(rr.month,7) AS mon, count(*) AS runs,
           min((rr.report->>'rate_limit_hits')::int) AS min_h,
           max((rr.report->>'rate_limit_hits')::int) AS max_h,
           count(DISTINCT rr.report->>'api_items')          AS d_items,
           count(DISTINCT rr.report->>'pages')              AS d_pages,
           count(DISTINCT rr.report->>'api_clawback_total') AS d_claw,
           count(DISTINCT rr.report->>'api_signed_total')   AS d_signed,
           count(DISTINCT rr.report->>'api_items_via_catchall') AS d_catch
    FROM public.repull_reports rr
    WHERE left(rr.month,7) IN ('2026-02','2026-03','2026-04')
      AND rr.report ? 'api_signed_total'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % runs | hits %..% | distinct: items % pages % claw % signed % catch-all % | %',
      r.mon, r.runs, lpad(r.min_h::text,3), lpad(r.max_h::text,3),
      r.d_items, r.d_pages, r.d_claw, r.d_signed, r.d_catch,
      CASE WHEN r.runs >= 2 AND r.d_items=1 AND r.d_pages=1
                AND r.d_claw=1 AND r.d_signed=1
           THEN 'TWO RUNS AGREE on every data field'
           WHEN r.runs < 2 THEN 'one run -- proves nothing'
           ELSE 'DATA MOVED -- hits are not cosmetic' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   what each month would add if applied:';
  FOR r IN
    SELECT left(rr.month,7) AS mon,
           max((rr.report->>'api_clawback_total')::numeric) AS claw
    FROM public.repull_reports rr
    WHERE left(rr.month,7) IN ('2026-02','2026-03','2026-04')
      AND rr.report ? 'api_signed_total'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | clawbacks % (plus whatever reimbursement income moves)',
         r.mon, lpad(r.claw::text,9); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   NOTE: every one of these runs was a DRY RUN (applied=false).';
  RAISE NOTICE '   Feb, Mar and Apr remain unapplied and nothing here changes that.';
END
$p$;
