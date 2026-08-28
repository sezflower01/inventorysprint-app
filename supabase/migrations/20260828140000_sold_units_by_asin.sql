-- Per-ASIN sold totals for the Unshipped Purchases reconciliation.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- /tools/unshipped-purchases decides whether a purchase reached Amazon by
-- looking at fba_shipment_items alone. Measured against a real ASIN on
-- 2026-08-28 (B0G4BQ42W3):
--
--   purchased                     1,480
--   fba_shipment_items shipped       58   <- what the page believed
--   actually sold                   977
--   in stock now                    119
--
-- The page reported 1,422 units / $21,000 unaccounted. The true figure is
-- ~384 units / ~$5,450. Shipment history is drastically incomplete -- it does
-- not reach back far enough -- so units that sold months ago were being
-- reported as never having arrived, and the headline was overstated ~4x.
--
-- A sale is the strongest possible proof a unit reached Amazon: Amazon cannot
-- ship to a customer what it never received. Current stock is the same kind of
-- evidence. Both are more reliable here than the shipment table.
--
-- ── WHY AN RPC RATHER THAN CLIENT-SIDE ────────────────────────────────────
--
-- PostgREST has no GROUP BY, so the page would otherwise have to pull every
-- sales_orders row for the account and total them in the browser. That table
-- is ~70k rows and growing; at PostgREST's 1000-row page size that is 70+
-- round trips on every page load, and getting the paging subtly wrong would
-- silently understate sales -- which is exactly the failure being fixed.
-- One aggregate server-side is a single round trip and cannot half-succeed.
--
-- ── SECURITY ──────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER, and scoped with auth.uid() rather than taking a user id
-- parameter. A SECURITY DEFINER function with a p_user_id argument would let
-- any authenticated caller read any other account's sales totals simply by
-- passing a different uuid. INVOKER also keeps sales_orders RLS in force, so
-- this cannot become a way around it.

CREATE OR REPLACE FUNCTION public.sold_units_by_asin()
RETURNS TABLE (asin text, units_sold bigint, units_refunded bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    o.asin,
    COALESCE(SUM(o.quantity), 0)::bigint,
    COALESCE(SUM(COALESCE(o.refund_quantity, 0)), 0)::bigint
  FROM public.sales_orders o
  WHERE o.user_id = auth.uid()
    AND o.asin IS NOT NULL
  GROUP BY o.asin;
$$;

REVOKE ALL ON FUNCTION public.sold_units_by_asin() FROM public;
GRANT EXECUTE ON FUNCTION public.sold_units_by_asin() TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.sold_units_by_asin()') IS NULL THEN
    RAISE EXCEPTION 'sold_units_by_asin() did not install';
  END IF;
  RAISE NOTICE 'sold_units_by_asin() ready (security invoker, auth.uid scoped)';
END $$;
