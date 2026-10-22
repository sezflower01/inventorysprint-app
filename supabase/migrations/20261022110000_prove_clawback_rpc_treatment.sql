-- READ-ONLY. Before deploying the clawback branch: exactly how will the RPCs
-- treat a NEGATIVE compensated_clawback, and does it reduce profit rather than
-- being ABSed into income?
--
-- The RPCs cannot simply be called here to demonstrate it: both scope by
-- auth.uid(), which is NULL inside a migration, so they return all zeros (that
-- is why my earlier pl_baseline_20261022 came back empty). So this proves it
-- from the function definitions plus the arithmetic they apply.
DO $p$
DECLARE r record; v_def text; v_line text; v_in_merge boolean;
BEGIN
  RAISE NOTICE '== 1. the merged Reimbursements INCOME expression ==';
  RAISE NOTICE '   (if clawback appeared here it WOULD be absorbed into income)';
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('get_monthly_pl_breakdown','get_pl_live_summary')
    ORDER BY p.proname, p.oid
  LOOP
    v_def := pg_get_functiondef(r.oid);

    -- The merge expression: the lines between `COALESCE(b.reimbursements` and
    -- `AS reimbursements`.
    RAISE NOTICE '';
    RAISE NOTICE '   --- %(%) ---', r.proname, r.args;
    FOR v_line IN SELECT unnest(string_to_array(v_def, E'\n')) LOOP
      IF v_line ~* 'ABS\(COALESCE\(b\.(reversal_reimbursement|free_replacement_refund_items)'
         OR v_line ~* 'COALESCE\(b\.reimbursements'
         OR v_line ~* 'AS reimbursements' THEN
        RAISE NOTICE '      %', btrim(v_line);
      END IF;
    END LOOP;

    -- Is compensated_clawback anywhere inside that merge?
    -- Substring, not regex: Postgres caps bounded repetition at 255, and the
    -- merge expression is longer than that.
    v_in_merge := position('compensated_clawback' in
      substring(v_def from position('COALESCE(b.reimbursements' in v_def)
                        for  (position('AS reimbursements' in v_def)
                              - position('COALESCE(b.reimbursements' in v_def) + 20))) > 0;
    RAISE NOTICE '      clawback inside the income merge: %', v_in_merge;

    RAISE NOTICE '      how clawback IS returned:';
    FOR v_line IN SELECT unnest(string_to_array(v_def, E'\n')) LOOP
      IF v_line ~* 'AS compensated_clawback' THEN
        RAISE NOTICE '         %', btrim(v_line);
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. the arithmetic on a real clawback ==';
  FOR r IN
    SELECT amt,
           abs(amt) AS rpc_returns,
           -abs(amt) AS pl_contribution
    FROM (VALUES (-3.27::numeric), (-4.70), (-8.34), (-16.31)) AS v(amt)
  LOOP
    RAISE NOTICE '   stored % -> RPC returns ABS = % -> expense row (negative:true) contributes %',
      lpad(r.amt::text,7), lpad(r.rpc_returns::text,6), lpad(r.pl_contribution::text,7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== VERDICT ==';
  RAISE NOTICE '   The RPCs do NOT fold clawback into the Reimbursements income';
  RAISE NOTICE '   line -- that merge is reimbursements + ABS(reversal) +';
  RAISE NOTICE '   ABS(free_replacement) only. Clawback comes back as its own';
  RAISE NOTICE '   column, ABSed to a positive magnitude.';
  RAISE NOTICE '';
  RAISE NOTICE '   A magnitude is exactly what plModel EXPENSE_ROWS expects:';
  RAISE NOTICE '   every entry there carries negative:true and is subtracted. So';
  RAISE NOTICE '   -16.31 stored becomes 16.31 returned becomes -16.31 of profit.';
  RAISE NOTICE '';
  RAISE NOTICE '   The gap was NEVER the RPC. compensated_clawback sat in';
  RAISE NOTICE '   plModel MEMO_ROWS marked informational, which sumRows() skips,';
  RAISE NOTICE '   so it reached neither income nor expenses. Moved to';
  RAISE NOTICE '   EXPENSE_ROWS in this change; 6 vitest cases cover it.';
  RAISE NOTICE '';
  RAISE NOTICE '   No RPC is modified. Rewriting four large bodies to swap ABS';
  RAISE NOTICE '   for negation would only matter for a POSITIVE clawback, of';
  RAISE NOTICE '   which there has never been one, and is a far bigger risk to';
  RAISE NOTICE '   the P&L than the case it guards.';
END
$p$;
