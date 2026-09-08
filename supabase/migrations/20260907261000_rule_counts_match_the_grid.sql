-- Make in_stock_asins mean what the Repricer grid shows.
--
-- The previous version counted available + reserved + inbound + unfulfilled,
-- matching the ghost rule. That returned 17 for "FBM Competes with all" where
-- the seller counts 8, because nine of those listings have zero AVAILABLE and
-- only reserved or inbound units.
--
-- The whole point of this field is that the badge should agree with the grid
-- underneath it. The grid hides rows with no available stock, so the badge has
-- to use the same test. Counting stock that is committed to an order or still
-- in transit is defensible in the abstract and useless here -- it reproduces
-- the exact mismatch this was added to remove.
--
-- available > 0 it is.

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
  SELECT a.rule_id,
         count(*)                                            AS assignments,
         count(*) FILTER (WHERE a.is_enabled)                AS enabled_assignments,
         count(DISTINCT a.asin)                              AS distinct_asins,
         count(DISTINCT a.asin) FILTER (WHERE a.is_enabled)  AS enabled_asins,
         -- Deliberately AVAILABLE only, to agree with the grid.
         count(DISTINCT a.asin) FILTER (
           WHERE a.is_enabled
             AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
             AND COALESCE(i.available,0) > 0
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
  FOR r IN
    SELECT rr.name, c.distinct_asins, c.enabled_asins, c.in_stock_asins
    FROM public.get_rule_assignment_counts() c
    JOIN public.repricer_rules rr ON rr.id = c.rule_id
    WHERE rr.name IN ('FBM Competes with all','Momentum Smart')
    ORDER BY c.distinct_asins DESC
  LOOP
    RAISE NOTICE '   %-26s total % | enabled % | AVAILABLE %',
      left(r.name,26), r.distinct_asins, r.enabled_asins, r.in_stock_asins;
  END LOOP;
  RAISE NOTICE '   (FBM Competes with all should now read 8 -- the seller''s count)';
END $verify$;
