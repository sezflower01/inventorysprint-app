-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Second read of inventory_valuation_summary after the deploy, to confirm the
-- 10-minute cron recomputed it with the COG precedence.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '';
  FOR r IN
    SELECT value, units, skus, computed_at,
           round(EXTRACT(EPOCH FROM (now() - computed_at))/60.0, 1) AS age_min
    FROM public.inventory_valuation_summary WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  stored value: %   units: %   skus: %', round(r.value::numeric, 2), r.units, r.skus;
    RAISE NOTICE '  computed_at : %  (% min ago)', r.computed_at, r.age_min;
    IF r.value > 59900 AND r.value < 60050 THEN
      RAISE NOTICE '  -> NEW COG-based total. Deployed function is live and correct.';
    ELSIF r.value > 59200 AND r.value < 59300 THEN
      RAISE NOTICE '  -> still the OLD total; cron has not re-run since the deploy.';
    ELSE
      RAISE NOTICE '  -> unexpected; investigate.';
    END IF;
  END LOOP;
END
$p$;
