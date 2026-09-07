-- Exactly one default rule.
--
-- ---- WHAT WAS WRONG -----------------------------------------------------
--
-- Three rules carried is_default = true:
--   Momentum Builder  8362f6c1-89bb-44a0-a5c1-d03914010419
--   Balanced          98616790-7699-4e86-a7d3-b11a4674ab8c
--   Momentum Builder  60b80c70-51e9-4424-9fa5-14840984f4db
--
-- Two of them share a name, which makes the duplication invisible in the UI --
-- the rule list shows "Momentum Builder ⭐ Default" twice and it reads as one
-- entry. Anything falling back to the default picks whichever row the query
-- returns first, which is not deterministic without an ORDER BY. So a new or
-- repaired assignment could land on any of the three, and hand-assignment
-- quietly drifts back.
--
-- ---- WHAT THIS DOES -----------------------------------------------------
--
-- Keeps the flag on the ONE rule that is actually in use -- the flagged rule
-- with the most assignments -- and clears it from the others. That is
-- deliberately the choice that changes nothing about today's behaviour: the
-- rule most things already fall back to stays the default.
--
-- It does NOT reassign anything. Which rule the catalogue should run is the
-- seller's decision, not a side effect of a de-duplication.
--
-- Per-user, because is_default is scoped by user_id and this must stay correct
-- for every account, not just the one that prompted it.

DO $$
DECLARE r record; v_keep uuid; v_cleared int; v_total int := 0;
BEGIN
  FOR r IN
    SELECT user_id, count(*) AS defaults
    FROM public.repricer_rules WHERE is_default = true
    GROUP BY user_id HAVING count(*) > 1
  LOOP
    -- Most-assigned wins; ties break on the oldest rule, so the choice is
    -- stable rather than whatever the planner returns today.
    SELECT rr.id INTO v_keep
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    WHERE rr.user_id = r.user_id AND rr.is_default = true
    GROUP BY rr.id, rr.created_at
    ORDER BY count(a.id) DESC, rr.created_at ASC
    LIMIT 1;

    UPDATE public.repricer_rules
       SET is_default = false, updated_at = now()
     WHERE user_id = r.user_id AND is_default = true AND id <> v_keep;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    v_total := v_total + v_cleared;

    RAISE NOTICE 'user %: % defaults -> kept %, cleared %', r.user_id, r.defaults, v_keep, v_cleared;
  END LOOP;

  IF v_total = 0 THEN
    RAISE NOTICE 'no user had more than one default rule';
  END IF;
END $$;

-- Stop it recurring. A partial unique index is the right shape here: it
-- constrains only the rows where is_default is true, so any number of
-- non-default rules per user remains fine.
CREATE UNIQUE INDEX IF NOT EXISTS repricer_rules_one_default_per_user
  ON public.repricer_rules (user_id)
  WHERE is_default = true;

DO $$
DECLARE r record;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'defaults after the fix:';
  FOR r IN
    SELECT rr.name, rr.id, count(a.id) AS assignments
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    WHERE rr.is_default = true
    GROUP BY rr.id, rr.name ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   % (%) -- % assignments', r.name, r.id, r.assignments;
  END LOOP;
END $$;
