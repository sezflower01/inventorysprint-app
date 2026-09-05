-- Make the "compete with FBM" checkbox mean what it says, on every rule.
--
-- ---- WHAT WAS WRONG -----------------------------------------------------
--
-- repricer-ai-evaluate derived the flag as:
--
--   competeWithFbm: rule.ignore_fbm_unless_buybox_owner === false
--     ? true                              -- forced, overriding the checkbox
--     : (rule.compete_with_fbm ?? true)
--
-- so a second, older field silently overrode the explicit setting. Measured
-- 2026-09-04, four rules had compete_with_fbm = false and competed with FBM
-- anyway: Aggressive Capture, Match Buy Box, Smart Match, and -- with a
-- certain irony -- the rule named "Compete with FBM". Unticking the box did
-- nothing on any of them.
--
-- ---- WHY THIS MIGRATION CHANGES NO PRICING ------------------------------
--
-- Making the checkbox authoritative on its own would flip those four rules to
-- NOT competing with FBM, which is a real pricing change on live listings and
-- the opposite of what is wanted -- FBM offers appear on nearly every listing,
-- so competing with them is usually the point.
--
-- So the data is corrected to match the behaviour rather than the behaviour
-- corrected to match the data: rules that were EFFECTIVELY competing get
-- compete_with_fbm = true. Effective behaviour is byte-for-byte identical
-- afterwards; only the checkbox stops lying. From then on, changing it
-- actually takes effect.
--
-- ignore_fbm_unless_buybox_owner keeps its own separate job (the
-- shouldIgnoreFbm path). The two settings simply stop overriding each other,
-- which is what anyone reading the UI would already assume.

DO $$
DECLARE r RECORD; v_fixed int := 0; v_nulls int := 0;
BEGIN
  FOR r IN
    SELECT id, name, compete_with_fbm, ignore_fbm_unless_buybox_owner AS ig
    FROM public.repricer_rules
    -- Effectively TRUE under the old derivation, but stored FALSE.
    WHERE ignore_fbm_unless_buybox_owner IS FALSE
      AND compete_with_fbm IS DISTINCT FROM TRUE
  LOOP
    UPDATE public.repricer_rules SET compete_with_fbm = TRUE WHERE id = r.id;
    v_fixed := v_fixed + 1;
    RAISE NOTICE '  "%": stored % -> true (it was already competing)',
      COALESCE(r.name,'(unnamed)'), COALESCE(r.compete_with_fbm::text,'NULL');
  END LOOP;

  -- NULL means "never chosen", and the code default is true. Writing it makes
  -- the stored value agree with the behaviour instead of relying on a default
  -- two layers away.
  UPDATE public.repricer_rules SET compete_with_fbm = TRUE
   WHERE compete_with_fbm IS NULL;
  GET DIAGNOSTICS v_nulls = ROW_COUNT;

  RAISE NOTICE 'rules corrected: % overridden, % previously unset', v_fixed, v_nulls;
END $$;

-- Prove nothing moved: the effective value under the OLD derivation must equal
-- the stored value under the new one, for every rule.
DO $$
DECLARE v_mismatch int;
BEGIN
  SELECT count(*) INTO v_mismatch
  FROM public.repricer_rules
  WHERE (CASE WHEN ignore_fbm_unless_buybox_owner IS FALSE THEN true
              ELSE COALESCE(compete_with_fbm, true) END)
        IS DISTINCT FROM COALESCE(compete_with_fbm, true);
  RAISE NOTICE 'rules whose behaviour would CHANGE: % (want 0)', v_mismatch;
END $$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT name, compete_with_fbm, ignore_fbm_unless_buybox_owner AS ig
    FROM public.repricer_rules ORDER BY name LIMIT 20
  LOOP
    RAISE NOTICE '  % : compete_with_fbm=% ignore_fbm=%',
      rpad(COALESCE(r.name,'(unnamed)'), 36), r.compete_with_fbm, COALESCE(r.ig::text,'NULL');
  END LOOP;
END $$;
