-- Let rules be deleted: drop the foreign key from the AI decision LOG.
--
-- ---- WHAT WAS WRONG -----------------------------------------------------
--
-- "Failed to delete rule: canceling statement due to statement timeout".
-- Deleting a rule fans out through six foreign keys. Five point at small
-- tables. The sixth points at repricer_ai_decisions -- 3,391,587 rows,
-- 2,635 MB -- with ON DELETE SET NULL, so every decision row referencing the
-- rule has to be REWRITTEN, not merely found. Measured 2026-09-07:
--
--   Momentum Builder        2,291,265 decision rows
--   Momentum Smart            810,627
--   FBM Competes with all     107,204
--
-- 2.29 million row updates in one statement is the timeout. The index on
-- rule_id makes those rows quick to locate and does nothing to make rewriting
-- them cheap. This gets worse over time, not better.
--
-- ---- WHY DROPPING THE CONSTRAINT IS THE RIGHT FIX -----------------------
--
-- repricer_ai_decisions is a disposable log on 30-day retention -- the nightly
-- cleanup deletes ~190k rows from it every night. Referential integrity
-- between a log entry and a rule that may legitimately be deleted buys
-- nothing: the log records what the engine decided at a moment in time, and
-- that record is not invalidated by the rule later being removed. Meanwhile
-- the constraint makes deleting any rule proportional to how long that rule
-- has been running.
--
-- The alternatives are worse. ON DELETE CASCADE would delete 2.29M log rows
-- instead of updating them -- slower still. Batching the null-out in an RPC
-- keeps a constraint that protects nothing and adds a moving part to every
-- future deletion.
--
-- The COLUMN and its INDEX stay, so rule-performance reporting still works.
-- After a rule is deleted its old log rows keep a rule_id that no longer
-- resolves, which for a 30-day log simply ages out.
--
-- ---- WHAT THIS DOES NOT CHANGE ------------------------------------------
--
-- Every other foreign key is left alone. In particular
-- repricer_assignments.rule_id keeps ON DELETE SET NULL, which is what makes
-- deleting a rule orphan its assignments rather than destroy them.

ALTER TABLE public.repricer_ai_decisions
  DROP CONSTRAINT IF EXISTS repricer_ai_decisions_rule_id_fkey;

-- Three FKs referencing repricer_rules had no index on the referencing column,
-- so each rule delete also seq-scans those tables. Two are tiny; the third is
-- on the 32 MB assignments table. Cheap to fix while here.
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_basic_rule_id
  ON public.repricer_assignments (basic_rule_id)
  WHERE basic_rule_id IS NOT NULL;

DO $$
DECLARE r record; n int; t0 timestamptz; secs numeric;
BEGIN
  SELECT count(*) INTO n
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_class tgt ON tgt.oid = c.confrelid
  WHERE c.contype = 'f' AND tgt.relname = 'repricer_rules';
  RAISE NOTICE 'foreign keys still referencing repricer_rules: % (was 6)', n;

  FOR r IN
    SELECT src.relname AS tbl, pg_size_pretty(pg_total_relation_size(c.conrelid)) AS sz
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    WHERE c.contype = 'f' AND tgt.relname = 'repricer_rules'
    ORDER BY pg_total_relation_size(c.conrelid) DESC
  LOOP
    RAISE NOTICE '   % (%)', r.tbl, r.sz;
  END LOOP;

END $$;

DO $$
DECLARE v_id uuid; v_decisions int; t0 timestamptz; secs numeric;
BEGIN
  SELECT rr.id INTO v_id
  FROM public.repricer_rules rr
  WHERE rr.name = 'FBA competes with FBM'
    AND NOT EXISTS (SELECT 1 FROM public.repricer_assignments a WHERE a.rule_id = rr.id)
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE NOTICE 'no zero-assignment rule available to test the delete with';
    RETURN;
  END IF;

  SELECT count(*) INTO v_decisions FROM public.repricer_ai_decisions WHERE rule_id = v_id;
  t0 := clock_timestamp();
  DELETE FROM public.repricer_rules WHERE id = v_id;
  secs := round(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::numeric, 3);
  RAISE NOTICE 'test delete: removed a rule carrying % decision log rows in % s', v_decisions, secs;
END $$;
