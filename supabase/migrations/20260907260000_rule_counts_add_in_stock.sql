-- Add an in-stock ASIN count to the rule badge data.
--
-- ---- WHY -----------------------------------------------------------------
--
-- The badge said "18 ASINs" for FBM Competes with all; the seller counted 8 in
-- the Repricer table and asked which was right. Both were, of different
-- questions:
--
--   21 assignments | 18 distinct ASINs   <- what the badge showed
--   17 enabled     | 17 enabled ASINs
--    8 with available stock              <- what the table shows
--
-- The table hides zero-stock rows, so nine enabled-and-ACTIVE listings with
-- nothing to sell were counted by the badge and invisible in the grid. A badge
-- that disagrees with the screen underneath it by more than 2x is worse than
-- no badge -- this is the second time today its number has had to be explained
-- rather than read.
--
-- Adding in_stock_asins so the card can lead with the number a seller means by
-- "how many ASINs is this rule working on", and keep the fuller picture in the
-- tooltip.
--
-- Stock is available + reserved + inbound + unfulfilled, matching the ghost
-- rule in src/lib/ghostFilter.ts rather than inventing a third definition.

DROP FUNCTION IF EXISTS public.get_rule_assignment_counts();

CREATE OR REPLACE FUNCTION public.get_rule_assignment_counts()
RETURNS TABLE (
  rule_id uuid,
  assignments bigint,
  enabled_assignments bigint,
  distinct_asins bigint,
  enabled_asins bigint,
  in_stock_asins bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  -- SECURITY INVOKER on purpose: repricer_assignments is RLS-scoped by
  -- user_id, so the caller sees only their own rows.
  SELECT a.rule_id,
         count(*)                                            AS assignments,
         count(*) FILTER (WHERE a.is_enabled)                AS enabled_assignments,
         count(DISTINCT a.asin)                              AS distinct_asins,
         count(DISTINCT a.asin) FILTER (WHERE a.is_enabled)  AS enabled_asins,
         count(DISTINCT a.asin) FILTER (
           WHERE a.is_enabled
             AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
             AND COALESCE(i.available,0) + COALESCE(i.reserved,0)
               + COALESCE(i.inbound,0)   + COALESCE(i.unfulfilled,0) > 0
         )                                                   AS in_stock_asins
  FROM public.repricer_assignments a
  LEFT JOIN public.inventory i
         ON i.user_id = a.user_id AND i.sku = a.sku
  WHERE a.rule_id IS NOT NULL
  GROUP BY a.rule_id;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_rule_assignment_counts() TO authenticated;

DO $verify$
DECLARE r record;
BEGIN
  RAISE NOTICE 'per-rule counts (postgres, so across accounts):';
  FOR r IN
    SELECT rr.name, c.distinct_asins, c.enabled_asins, c.in_stock_asins
    FROM public.get_rule_assignment_counts() c
    JOIN public.repricer_rules rr ON rr.id = c.rule_id
    ORDER BY c.distinct_asins DESC LIMIT 6
  LOOP
    RAISE NOTICE '   %-26s total % | enabled % | in stock %',
      left(r.name,26), r.distinct_asins, r.enabled_asins, r.in_stock_asins;
  END LOOP;
END $verify$;
