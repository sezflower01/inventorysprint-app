-- Read-only: does every overload of the P&L breakdown return facilitator tax?
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           pg_get_function_result(p.oid) LIKE '%marketplace_facilitator_tax%' AS has_fac
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_monthly_pl_breakdown'
  LOOP
    RAISE NOTICE '  % | returns facilitator tax: %', r.sig, r.has_fac;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           prosrc LIKE '%facilitator%' AS body_has_fac
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_monthly_pl_breakdown'
  LOOP
    RAISE NOTICE '  % | body mentions facilitator: %', r.sig, r.body_has_fac;
  END LOOP;
END $$;
