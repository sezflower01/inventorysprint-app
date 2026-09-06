-- Count rule assignments in the database instead of in the browser.
--
-- ---- WHAT WAS WRONG -----------------------------------------------------
--
-- RuleBuilder built the "N ASINs" badge on every rule card by fetching rows
-- and counting them client-side:
--
--   supabase.from("repricer_assignments").select("rule_id").in("rule_id", ruleIds)
--
-- No .limit(), no range paging, no exact count. PostgREST caps a response at
-- 1,000 rows and truncates SILENTLY -- no error, no warning. Measured
-- 2026-09-06: 6,214 assignments across 17 rules, so the badges were dividing
-- up a truncated 1,000 and every one of them was wrong. Momentum Smart showed
-- 54 where the true figure is 525 assignments over 254 distinct ASINs.
--
-- Worse, the numbers shrink as the account grows: more rules competing for the
-- same 1,000 rows means smaller and smaller shares, so the badge degrades
-- exactly when the account gets big enough for it to matter.
--
-- ---- WHY AN RPC RATHER THAN COUNT-PER-RULE -------------------------------
--
-- PostgREST can return an exact count with { count: 'exact', head: true },
-- but only one filter at a time, so that is one HTTP round trip per rule and
-- still cannot express COUNT(DISTINCT asin). Grouping belongs in SQL.
--
-- ---- ASSIGNMENTS ARE NOT ASINs -------------------------------------------
--
-- An assignment is per (asin, marketplace). With four marketplaces authorised,
-- one ASIN can carry four assignments -- Momentum Builder holds 2,203
-- assignments over 929 distinct ASINs. A badge labelled "ASINs" should show
-- ASINs, so this returns both and the UI can label each honestly.

CREATE OR REPLACE FUNCTION public.get_rule_assignment_counts()
RETURNS TABLE (
  rule_id uuid,
  assignments bigint,
  enabled_assignments bigint,
  distinct_asins bigint,
  enabled_asins bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  -- SECURITY INVOKER on purpose: repricer_assignments is RLS-scoped by
  -- user_id, so the caller sees only their own rows and no extra filter is
  -- needed here. A DEFINER function would have to re-implement that check.
  SELECT a.rule_id,
         count(*)                                            AS assignments,
         count(*) FILTER (WHERE a.is_enabled)                AS enabled_assignments,
         count(DISTINCT a.asin)                              AS distinct_asins,
         count(DISTINCT a.asin) FILTER (WHERE a.is_enabled)  AS enabled_asins
  FROM public.repricer_assignments a
  WHERE a.rule_id IS NOT NULL
  GROUP BY a.rule_id;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_rule_assignment_counts() TO authenticated;

DO $verify$
DECLARE r record; n int := 0;
BEGIN
  RAISE NOTICE 'per-rule counts as the function sees them (postgres, so all users):';
  FOR r IN
    SELECT rr.name, c.assignments, c.enabled_assignments, c.distinct_asins
    FROM public.get_rule_assignment_counts() c
    JOIN public.repricer_rules rr ON rr.id = c.rule_id
    ORDER BY c.assignments DESC LIMIT 6
  LOOP
    n := n + 1;
    RAISE NOTICE '   %-30s % assignments | % enabled | % distinct ASINs',
      left(r.name,30), r.assignments, r.enabled_assignments, r.distinct_asins;
  END LOOP;
  IF n = 0 THEN RAISE WARNING 'function returned nothing -- check RLS on repricer_assignments'; END IF;
END $verify$;
