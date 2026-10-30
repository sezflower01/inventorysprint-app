-- READ-ONLY. Two loose ends from the August apply.
--
-- 1. EIGHT ROWS CAME BACK 'CHANGED'. January, May, June and July produced only
--    'new' and 'REMOVED' -- a key present on one side and absent on the other.
--    CHANGED means the same key existed before AND after with different money,
--    i.e. Amazon restated a row rather than adding or dropping one. All eight
--    are adjustments and carry no clawback, so no gate caught them, and nothing
--    says what moved inside them. That is worth knowing before August is
--    accepted, and worth watching for in September.
--
-- 2. The net profit movement for every applied month, on one footing, computed
--    from each month's own backup.
--
--    THE SIGN TRAP: compensated_clawback is stored NEGATIVE and the RPC ABSes
--    it into an expense magnitude, so in raw-column terms its profit
--    contribution is the stored delta ITSELF (negative). Every other expense
--    column is stored as a positive magnitude and must be SUBTRACTED. Getting
--    that backwards would double the clawback instead of booking it.
--
--    Income here counts reimbursements, reversal_reimbursement AND
--    free_replacement_refund_items, because the P&L's Reimbursements line is
--    the merge of all three -- the August movement was entirely in the latter
--    two (+16.54 and +8.57 = the +25.11 the merged line showed).
DO $p$
DECLARE r record; v_uid uuid; v_m date; v_months date[];
        v_net numeric; v_claw numeric; v_unknown int;
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

  RAISE NOTICE '== 1. the eight CHANGED August rows: what moved inside them ==';
  FOR r IN
    SELECT d.event_date, COALESCE(d.asin,'(none)') AS asin, e.k AS col,
           COALESCE(d.before_money ->> e.k,'-') AS was,
           COALESCE(d.after_money  ->> e.k,'-') AS now
    FROM public.fec_diff_month(v_uid,'2026-08-01'::date) d
    CROSS JOIN LATERAL (
      SELECT DISTINCT key AS k
      FROM (SELECT jsonb_object_keys(COALESCE(d.before_money,'{}'::jsonb)) AS key
            UNION SELECT jsonb_object_keys(COALESCE(d.after_money,'{}'::jsonb))) u) e
    WHERE d.verdict = 'CHANGED'
      AND COALESCE(d.before_money ->> e.k,'~') <> COALESCE(d.after_money ->> e.k,'~')
    ORDER BY d.event_date, e.k
  LOOP
    RAISE NOTICE '   % | % | % : % -> %', r.event_date, rpad(r.asin,12),
      rpad(r.col,26), lpad(left(r.was,22),22), lpad(left(r.now,22),22);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   no differing columns -- then CHANGED is about the KEY, not the money';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. net profit movement per applied month, from its backup ==';
  RAISE NOTICE '   month   | clawback   | other moved | NET PROFIT | unknown cols';
  v_months := ARRAY['2026-01-01','2026-05-01','2026-06-01','2026-07-01','2026-08-01']::date[];
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
        -- stored negative; its own delta IS the profit effect
        v_claw := v_claw + r.delta;
        v_net  := v_net  + r.delta;
      ELSIF r.col = ANY(v_income) THEN
        v_net := v_net + r.delta;
      ELSIF r.col = ANY(v_exp) THEN
        v_net := v_net - r.delta;
      ELSE
        v_unknown := v_unknown + 1;
        RAISE NOTICE '      % UNKNOWN COLUMN % delta % -- excluded',
          to_char(v_m,'YYYY-MM'), r.col, r.delta;
      END IF;
    END LOOP;
    RAISE NOTICE '   % | % | % | % | %', to_char(v_m,'YYYY-MM'),
      lpad(round(v_claw,2)::text,10), lpad(round(v_net - v_claw,2)::text,11),
      lpad(round(v_net,2)::text,10), v_unknown;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   October is excluded on purpose: its backup was taken 10-22 when';
  RAISE NOTICE '   the month was part-grown (3,286 rows against 4,551 now), so a';
  RAISE NOTICE '   backup-vs-live delta there measures the month continuing, not';
  RAISE NOTICE '   the re-pull. Its clawback total also keeps moving as Amazon';
  RAISE NOTICE '   posts -- do not quote October as final.';
END
$p$;
