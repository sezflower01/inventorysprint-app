-- Delete four empty / near-empty rules, scoped to one account.
--
-- ---- WHICH "EMPTY MOMENTUM BUILDER" -------------------------------------
--
-- The seller asked for "the empty duplicate Momentum Builder". Their own rule
-- list has no such thing -- the bare "Momentum Builder" showing 0 assignments
-- in earlier output belongs to a DIFFERENT ACCOUNT, surfaced because those
-- probes ran as postgres with no user filter. Their near-empty Builder variant
-- is "Momentum Builder (Copy)", which carries 1 assignment.
--
-- So this deletes, for sezflower01 only:
--   Testing ROI                              0 assignments
--   No Automatic lowering Momentum Smart     0 assignments
--   Momentum Builder (Copy)                  1 assignment
--   Match Buy Box                            1 assignment
--
-- Every statement is scoped by user_id. Deleting another account's rule
-- because it shares a name would be the same class of error as reporting
-- their counts as this seller's.
--
-- ---- WHAT DELETING A RULE DOES TO ITS ASSIGNMENTS -----------------------
--
-- repricer_assignments.rule_id is ON DELETE SET NULL, so the two assignments
-- are ORPHANED, not destroyed. The dispatcher requires a rule_id, so an
-- orphaned assignment stops being repriced. Both are checked below and the
-- migration refuses to commit if either is ENABLED -- an enabled listing
-- silently dropping out of repricing is exactly the kind of quiet change that
-- should never ride along with a tidy-up.
--
-- This is fast now only because 20260907150000 dropped the FK from the
-- 2.6 GB decision log. Before that, deleting a rule with any history hit the
-- statement timeout.

BEGIN;

CREATE TEMP TABLE _doomed ON COMMIT DROP AS
SELECT rr.id, rr.name, rr.is_default,
       (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = rr.id) AS assignments,
       (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = rr.id AND a.is_enabled) AS enabled,
       (SELECT count(*) FROM public.repricer_ai_decisions d WHERE d.rule_id = rr.id) AS decision_rows
FROM public.repricer_rules rr
WHERE rr.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
  AND rr.name IN (
    'Testing ROI',
    'No Automatic lowering Momentum Smart',
    'Momentum Builder (Copy)',
    'Match Buy Box'
  );

DO $$
DECLARE r record; n int; v_enabled int; v_default int;
BEGIN
  RAISE NOTICE '================ BEFORE ================';
  SELECT count(*) INTO n FROM _doomed;
  FOR r IN SELECT * FROM _doomed ORDER BY assignments DESC, name LOOP
    RAISE NOTICE '   %-38s | % assignments (% enabled) | % decision log rows | default=%',
      left(r.name,38), r.assignments, r.enabled, r.decision_rows, r.is_default;
  END LOOP;
  RAISE NOTICE 'matched % rules for this account', n;

  IF n = 0 THEN
    RAISE EXCEPTION 'no rules matched -- refusing to commit a no-op that looks like success';
  END IF;

  -- Refuse to silently un-reprice a live listing.
  SELECT COALESCE(sum(enabled),0) INTO v_enabled FROM _doomed;
  IF v_enabled > 0 THEN
    RAISE EXCEPTION 'refusing: % ENABLED assignments would be orphaned and stop repricing. Reassign them first.', v_enabled;
  END IF;

  -- Never delete the default; new ASINs would have nowhere to land.
  SELECT count(*) INTO v_default FROM _doomed WHERE is_default;
  IF v_default > 0 THEN
    RAISE EXCEPTION 'refusing: % of these is the default rule', v_default;
  END IF;
END $$;

DELETE FROM public.repricer_rules rr
 USING _doomed d
 WHERE rr.id = d.id;

DO $$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================ AFTER ================';
  SELECT count(*) INTO n
  FROM public.repricer_rules rr JOIN _doomed d ON d.id = rr.id;
  RAISE NOTICE 'deleted rules still present: % (must be 0)', n;
  IF n <> 0 THEN RAISE EXCEPTION 'delete incomplete'; END IF;

  FOR r IN
    SELECT count(*) AS rules,
           count(*) FILTER (WHERE is_default) AS defaults
    FROM public.repricer_rules
    WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
  LOOP
    RAISE NOTICE 'rules remaining for this account: % (% default)', r.rules, r.defaults;
  END LOOP;

  FOR r IN
    SELECT count(*) AS orphaned
    FROM public.repricer_assignments
    WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
      AND rule_id IS NULL AND is_enabled
  LOOP
    RAISE NOTICE 'ENABLED assignments with no rule: % (must be 0)', r.orphaned;
    IF r.orphaned <> 0 THEN
      RAISE EXCEPTION 'an enabled assignment lost its rule';
    END IF;
  END LOOP;
END $$;

COMMIT;
