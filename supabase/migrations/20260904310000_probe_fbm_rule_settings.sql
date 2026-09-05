-- Read-only: what does compete-with-FBM actually resolve to per rule?
--
-- The effective value is NOT just compete_with_fbm. It is:
--   ignore_fbm_unless_buybox_owner = false  -> forced TRUE
--   otherwise                               -> compete_with_fbm, DEFAULTING TO TRUE
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, name,
           compete_with_fbm,
           ignore_fbm_unless_buybox_owner AS ignore_fbm,
           CASE WHEN ignore_fbm_unless_buybox_owner IS FALSE THEN true
                ELSE COALESCE(compete_with_fbm, true) END AS effective
    FROM public.repricer_rules
    ORDER BY name LIMIT 15
  LOOP
    RAISE NOTICE '  rule "%": compete_with_fbm=% ignore_fbm=% -> EFFECTIVE=%',
      COALESCE(r.name,'(unnamed)'),
      COALESCE(r.compete_with_fbm::text,'NULL'),
      COALESCE(r.ignore_fbm::text,'NULL'),
      r.effective;
  END LOOP;
END $$;
