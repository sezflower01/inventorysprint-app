-- READ-ONLY. Item 1 of the reimbursement scoping: do the P&L RPCs sum
-- reversal_reimbursement and reimbursements, and with what sign?
--
-- This matters more than the raw column totals I reported yesterday. plModel.ts
-- labels its Reimbursements row "Merged total (generic + reversal +
-- free-replacement subtypes) from the RPC" and puts the subtypes in MEMO_ROWS
-- with informational: true, which sumRows() skips. So the RPC, not the table
-- column, decides whether $12,726.92 of reversals reaches the P&L. The raw
-- column reading $0.00 proves nothing on its own.
DO $p$
DECLARE r record; v_def text; v_line text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_monthly_pl_breakdown','get_pl_live_summary')
    ORDER BY p.proname, p.oid
  LOOP
    v_def := pg_get_functiondef(r.oid);
    RAISE NOTICE '';
    RAISE NOTICE '======================================================';
    RAISE NOTICE '== %(%)', r.proname, r.args;
    RAISE NOTICE '======================================================';

    -- Print only the lines that mention the columns in question, so the
    -- expressions are visible without dumping hundreds of lines.
    FOR v_line IN
      SELECT unnest(string_to_array(v_def, E'\n'))
    LOOP
      IF v_line ~* '(reimbursement|warehouse_lost|warehouse_damage|free_replacement|compensated_clawback)' THEN
        RAISE NOTICE '   %', btrim(v_line);
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what the RPC actually RETURNS for the affected months ==';
  RAISE NOTICE '   (the merged reimbursements figure the P&L adds as income)';
END
$p$;
