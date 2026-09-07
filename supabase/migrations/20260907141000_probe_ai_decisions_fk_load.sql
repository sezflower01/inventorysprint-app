-- PROBE (read-only): how many repricer_ai_decisions rows would a rule delete
-- have to rewrite?
--
-- Deleting a rule fans out through six foreign keys. Five point at small
-- tables. One points at repricer_ai_decisions, which is 2,635 MB, and its FK
-- is ON DELETE SET NULL -- so every decision row referencing that rule must be
-- UPDATED, not just found. The index makes them quick to locate and does
-- nothing to make rewriting them cheap.
--
-- repricer_assignments adds its own weight: 1,891 rows set to null, each
-- firing SIX per-row UPDATE triggers including trg_broadcast_assignment_ui,
-- the realtime broadcast on a 185-column table.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== decision rows per rule ========';
  FOR r IN
    SELECT rr.name, rr.id,
           (SELECT count(*) FROM public.repricer_ai_decisions d WHERE d.rule_id = rr.id) AS decisions,
           (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = rr.id) AS assignments
    FROM public.repricer_rules rr
    ORDER BY decisions DESC LIMIT 8
  LOOP
    RAISE NOTICE '   %-32s : % decision rows | % assignments', left(r.name,32), r.decisions, r.assignments;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== totals ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE rule_id IS NOT NULL) AS with_rule,
           count(*) FILTER (WHERE rule_id IS NULL) AS already_null
    FROM public.repricer_ai_decisions
  LOOP
    RAISE NOTICE '   repricer_ai_decisions: % rows | % carry a rule_id | % already null',
      r.total, r.with_rule, r.already_null;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how old are the decision rows for the biggest rule? ========';
  FOR r IN
    SELECT date_trunc('month', d.created_at)::date AS mon, count(*) AS n
    FROM public.repricer_ai_decisions d
    WHERE d.rule_id = '60b80c70-51e9-4424-9fa5-14840984f4db'
    GROUP BY 1 ORDER BY 1 DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % : % rows', r.mon, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== retention on that table ========';
  FOR r IN
    SELECT table_key, retention_days, enabled
    FROM public.database_maintenance_settings
    WHERE table_key ILIKE '%ai_decision%'
  LOOP
    RAISE NOTICE '   % : keep % days, auto=%', r.table_key, r.retention_days, r.enabled;
    RAISE NOTICE '   (so these are disposable logs -- nulling their rule_id loses nothing)';
  END LOOP;
END
$probe$;
