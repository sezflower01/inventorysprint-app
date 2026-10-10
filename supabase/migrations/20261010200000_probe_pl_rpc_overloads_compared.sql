-- READ-ONLY PROBE 1 of 3. The two P&L RPC overloads.
--
-- Both get_monthly_pl_breakdown and get_pl_live_summary exist twice -- with and
-- without p_marketplace -- and the bodies differ by roughly 2,000 characters
-- each. Two copies of a definition is exactly the drift plModel.ts was written
-- to stop, one layer further down, so the question is whether they have already
-- drifted or are merely duplicated.
--
-- Nothing is applied. No Amazon calls.

DO $p$
DECLARE r record; v_1 text; v_2 text; n int;
BEGIN
  RAISE NOTICE '== the four definitions ==';
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           length(pg_get_functiondef(p.oid)) AS len,
           md5(pg_get_functiondef(p.oid)) AS fingerprint
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_monthly_pl_breakdown','get_pl_live_summary')
    ORDER BY p.proname, len
  LOOP
    RAISE NOTICE '  %(%) | % chars | md5 %',
      rpad(r.proname, 26), rpad(r.args, 42), lpad(r.len::text, 6), left(r.fingerprint, 12);
  END LOOP;

  -- Which categories does each body actually name? A category present in one
  -- and absent from the other is a real difference in the money, not a
  -- cosmetic one.
  RAISE NOTICE '';
  RAISE NOTICE '== category coverage: terms named in one body but not its twin ==';
  FOR r IN
    WITH defs AS (
      SELECT p.proname,
             CASE WHEN pg_get_function_identity_arguments(p.oid) ILIKE '%marketplace%'
                  THEN 'with_mkt' ELSE 'without_mkt' END AS variant,
             pg_get_functiondef(p.oid) AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('get_monthly_pl_breakdown','get_pl_live_summary')
    ), terms AS (
      SELECT unnest(ARRAY[
        'shipping_chargeback','fbm_shipping_label_fee','digital_services_fee',
        'fba_inbound_convenience_fee','liquidations_brokerage_fee',
        're_commerce_grading_charge','hrr_non_apparel','restocking_fee',
        'marketplace_facilitator_tax','reimbursements','compensated_clawback',
        'warehouse_lost','warehouse_damage','reversal_reimbursement',
        'free_replacement_refund_items','fba_customer_return_fees','liquidations'
      ]) AS term
    )
    SELECT t.term, d.proname,
           bool_or(d.variant='with_mkt' AND d.body ILIKE '%'||t.term||'%') AS in_with,
           bool_or(d.variant='without_mkt' AND d.body ILIKE '%'||t.term||'%') AS in_without
    FROM terms t CROSS JOIN defs d
    GROUP BY 1,2
    HAVING bool_or(d.variant='with_mkt' AND d.body ILIKE '%'||t.term||'%')
        <> bool_or(d.variant='without_mkt' AND d.body ILIKE '%'||t.term||'%')
    ORDER BY 2,1
  LOOP
    RAISE NOTICE '  % | % | with_mkt % | without_mkt %   <-- DIFFERS',
      rpad(r.proname,26), rpad(r.term,32), r.in_with, r.in_without;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '  (no category term appears in one variant and not the other)';
  END IF;

  -- The decisive test: same period, both overloads, same number or not.
  RAISE NOTICE '';
  RAISE NOTICE '== same period through both overloads of get_pl_live_summary ==';
  BEGIN
    PERFORM set_config('request.jwt.claim.sub',
      (SELECT id::text FROM auth.users WHERE email='sezflower01@gmail.com'), true);

    FOR r IN
      SELECT row_to_json(t) AS j
      FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text) t
    LOOP
      v_1 := r.j::text;
    END LOOP;
    FOR r IN
      SELECT row_to_json(t) AS j
      FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text, 'ALL') t
    LOOP
      v_2 := r.j::text;
    END LOOP;

    RAISE NOTICE '  2-arg : %', left(COALESCE(v_1,'(no row)'), 400);
    RAISE NOTICE '';
    RAISE NOTICE '  3-arg : %', left(COALESCE(v_2,'(no row)'), 400);
    RAISE NOTICE '';
    RAISE NOTICE '  identical: %', (v_1 IS NOT DISTINCT FROM v_2);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  could not call both: %', SQLERRM;
  END;
END
$p$;
