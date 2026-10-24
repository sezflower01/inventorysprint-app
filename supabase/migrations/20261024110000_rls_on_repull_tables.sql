-- Enable RLS on every table this re-pull work created. I should have done this
-- when creating them.
--
-- This is not a CI formality. public.fec_repull_backup holds FULL COPIES of
-- financial_events_cache rows -- sales, fees, taxes, order ids -- and a table in
-- the public schema without RLS is reachable through the API by any
-- authenticated user. The same goes for the three dated backup tables and the
-- inventory snapshot. RLS is on throughout the rest of this schema
-- (docs/module-access-control.md); these tables were the exception, and the
-- exception was mine.
--
-- Two shapes:
--
--   Tables carrying user_id get RLS plus an owner-scoped SELECT policy, so the
--   owner can read their own backup and nobody else can read any of it.
--
--   The operational tables (repull_schedule, repull_reports, pl_baseline) carry
--   no user_id and are driver bookkeeping. They get RLS with NO policy at all,
--   which denies every anon and authenticated request outright. service_role
--   BYPASSES RLS, so the cron driver and the edge function keep working -- a
--   table with RLS on and no policy is the correct way to say "service role
--   only", not an oversight.

-- ---- owner-scoped: these hold user rows ----------------------------------
ALTER TABLE IF EXISTS public.fec_repull_backup              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fec_october_backup_20261022    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fec_adjustment_backup_20261022 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.inventory_revive_backup_20261020 ENABLE ROW LEVEL SECURITY;

DO $p$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fec_repull_backup','fec_october_backup_20261022',
    'fec_adjustment_backup_20261022','inventory_revive_backup_20261020'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname=t) THEN
      -- Idempotent: DROP then CREATE, so a re-run cannot fail on a duplicate.
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_own_select', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = user_id)',
        t||'_own_select', t);
      RAISE NOTICE '   RLS + owner SELECT policy on public.%', t;
    END IF;
  END LOOP;
END
$p$;

-- ---- service-role only: driver bookkeeping, no user_id -------------------
ALTER TABLE IF EXISTS public.repull_schedule       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.repull_reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.pl_baseline_20261022  ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.repull_schedule IS
  'Work list for the 2026 adjustment re-pull. RLS enabled with NO policy on purpose: service_role bypasses RLS, so the driver works while every anon and authenticated request is denied.';
COMMENT ON TABLE public.repull_reports IS
  'Durable copies of repull-month-adjustments reports. RLS enabled with NO policy on purpose -- service_role only. net._http_response is purged in batches, so a report read once can vanish; this table is what the exposure table is built from.';

DO $p$
DECLARE r record; v_open int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '== RLS state of every table this work created ==';
  FOR r IN
    SELECT c.relname AS t, c.relrowsecurity AS rls,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('fec_repull_backup','fec_october_backup_20261022',
                        'fec_adjustment_backup_20261022','inventory_revive_backup_20261020',
                        'repull_schedule','repull_reports','pl_baseline_20261022')
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '   % | RLS % | % policies', rpad(r.t,34), r.rls, r.policies;
    IF NOT r.rls THEN v_open := v_open + 1; END IF;
  END LOOP;

  IF v_open > 0 THEN
    RAISE NOTICE '   >>> % table(s) STILL without RLS', v_open;
  ELSE
    RAISE NOTICE '   every one now has RLS enabled';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== any OTHER public table left without RLS? ==';
  FOR r IN
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
    ORDER BY c.relname LIMIT 20
  LOOP RAISE NOTICE '   %', r.t; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none -- the whole public schema has RLS on'; END IF;
END
$p$;
