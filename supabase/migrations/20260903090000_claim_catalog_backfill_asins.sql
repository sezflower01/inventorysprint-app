-- Round-robin claim for the catalogue brand backfill.
--
-- In SQL rather than in the worker because the selection is a join across
-- three tables (queue x cache x rotation state) that PostgREST cannot express
-- in one request. Doing it client-side would mean fetching a seller's whole
-- pending list to pick a slice off it -- for a 1,000-ASIN seller that is 1,000
-- rows over the wire to use 100.
--
-- Fairness is the point: ordering by last_worked_at NULLS FIRST means every
-- seller advances a slice per pass, instead of the planner draining sellers in
-- whatever order it likes and leaving the last one until the end. The state
-- row is stamped even when a seller yields no ASINs, so a finished seller
-- rotates to the back rather than being re-picked every single run.

CREATE OR REPLACE FUNCTION public.claim_catalog_backfill_asins(
  p_sellers    integer DEFAULT 40,
  p_per_seller integer DEFAULT 100,
  p_max        integer DEFAULT 1500
)
RETURNS TABLE(asin text, marketplace text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH picked_sellers AS (
    SELECT s.seller_id, s.marketplace
    FROM public.seller_catalog_backfill_state s
    ORDER BY s.last_worked_at ASC NULLS FIRST
    LIMIT GREATEST(p_sellers, 1)
  ),
  ranked AS (
    SELECT q.asin, q.marketplace,
           row_number() OVER (
             PARTITION BY q.seller_id, q.marketplace
             -- priority is the "newest first" rule: 1 = we watched them add it.
             ORDER BY q.priority, q.asin
           ) AS rn
    FROM public.seller_catalog_queue q
    JOIN picked_sellers ps
      ON ps.seller_id = q.seller_id AND ps.marketplace = q.marketplace
    JOIN public.asin_brand_cache c
      ON c.asin = q.asin AND c.checked_at IS NULL
  ),
  -- Data-modifying CTEs always run to completion whether or not the primary
  -- query reads them, so the rotation advances even on a pass that claims
  -- nothing.
  touched AS (
    UPDATE public.seller_catalog_backfill_state st
       SET last_worked_at = now()
      FROM picked_sellers ps
     WHERE st.seller_id = ps.seller_id AND st.marketplace = ps.marketplace
    RETURNING 1
  )
  SELECT DISTINCT ON (r.asin) r.asin, r.marketplace
  FROM ranked r
  WHERE r.rn <= GREATEST(p_per_seller, 1)
  ORDER BY r.asin
  LIMIT GREATEST(p_max, 1);
$fn$;

REVOKE ALL ON FUNCTION public.claim_catalog_backfill_asins(integer, integer, integer) FROM public, anon, authenticated;
