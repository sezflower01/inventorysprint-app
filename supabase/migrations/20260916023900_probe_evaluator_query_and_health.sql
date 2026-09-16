-- READ-ONLY PROBE. Creates nothing, changes nothing (role switch is local to
-- the transaction).
--
-- The COG-aware repricer-ai-evaluate (deployed 13:20:29 UTC) could not be
-- dry-run from SQL: it keeps verify_jwt = true and the vault holds no
-- service-role key. Verify what can be verified instead:
--   1. the exact lookup the new code runs, as service_role, for the two test
--      ASINs -- B0H4WH84HR must return 12.75, B0725P2SY3 (flagged $1.00
--      placeholder) must return nothing;
--   2. the evaluator is healthy after the deploy: decisions keep being logged
--      at the pre-deploy rate.

DO $p$
DECLARE v_uid uuid; r record; v_cost numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SET LOCAL ROLE service_role;
  FOR r IN SELECT unnest(ARRAY['B0H4WH84HR','B0725P2SY3','B0G4BQ42W3']) AS asin LOOP
    v_cost := NULL;
    SELECT unit_cost INTO v_cost FROM public.asin_cog_for_repricer
    WHERE user_id = v_uid AND asin = r.asin;
    RAISE NOTICE '  as service_role: asin_cog_for_repricer(%) = %', r.asin, COALESCE(v_cost::text, '(no row -> falls back to inventory/created_listings)');
  END LOOP;
  SET LOCAL ROLE postgres;

  RAISE NOTICE '';
  RAISE NOTICE '======== evaluator decisions logged per 5 minutes (deploy at 13:20:29) ========';
  FOR r IN
    SELECT to_char(date_trunc('hour', created_at) + floor(date_part('minute', created_at) / 5) * interval '5 min', 'HH24:MI') AS bucket,
           count(*) AS n,
           count(*) FILTER (WHERE new_price IS NOT NULL) AS with_price
    FROM public.repricer_ai_decisions
    WHERE user_id = v_uid AND created_at > now() - interval '40 minutes'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % : % decisions (% with a new price)', r.bucket, r.n, r.with_price;
  END LOOP;
END
$p$;
