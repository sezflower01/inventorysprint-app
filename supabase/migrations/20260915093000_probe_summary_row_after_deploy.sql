-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The frontend trusts inventory_valuation_summary for 30 minutes before it
-- falls back to computing live, so the deployed edge function -- not the
-- browser code -- is what the seller actually sees most of the time.
-- Read the row back and check it carries the new COG-based total.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '======== inventory_valuation_summary as stored ========';
  FOR r IN
    SELECT value, units, skus, computed_at,
           round(EXTRACT(EPOCH FROM (now() - computed_at))/60.0, 1) AS age_min
    FROM public.inventory_valuation_summary WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  value: %   units: %   skus: %', r.value, r.units, r.skus;
    RAISE NOTICE '  computed_at: %  (% minutes ago)', r.computed_at, r.age_min;
    IF round(r.value::numeric, 2) = 59967.58 THEN
      RAISE NOTICE '  -> MATCHES the new COG-based total (59967.58).';
    ELSIF round(r.value::numeric, 2) = 59260.63 THEN
      RAISE NOTICE '  -> still the OLD created_listings total (59260.63); needs a recompute.';
    ELSE
      RAISE NOTICE '  -> neither 59967.58 nor 59260.63 -- stock moved, compare the live figure below.';
    END IF;
  END LOOP;
END
$p$;
