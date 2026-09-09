-- Shortlist orders worth an SP-API call when hunting same-ASIN collapses.
--
-- This function does NOT decide what the corrected values are -- Amazon's
-- GetOrderItems does that in repair-collapsed-orders. Its only job is to keep
-- the repair from calling SP-API on all 72,000 rows.
--
-- The ratio it uses is fba_fee / the ASIN's own median per-unit fee. Measured
-- 2026-09-09: 1,722 rows exceed 1.6x, but only 444 land within 0.08 of a whole
-- number, and the remainder is ordinary FBA fee variance -- size-tier
-- reclassification, fee schedule changes, peak surcharges. Hence the integer
-- test, which is what makes this a shortlist rather than a guess.
--
-- Requires at least 3 samples for an ASIN before trusting its median.

CREATE OR REPLACE FUNCTION public.collapsed_order_candidates(
  p_user_id uuid,
  p_limit integer DEFAULT 25
)
RETURNS TABLE (
  id uuid,
  order_id text,
  asin text,
  quantity integer,
  sold_price numeric,
  total_sale_amount numeric,
  unit_cost numeric,
  total_cost numeric,
  referral_fee numeric,
  fba_fee numeric,
  total_fees numeric,
  order_date date,
  implied_units numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH per_unit AS (
    SELECT s.asin,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.fba_fee / NULLIF(s.quantity,0)) AS unit_fee
    FROM public.sales_orders s
    WHERE s.user_id = p_user_id
      AND COALESCE(s.fba_fee,0) > 0
      AND COALESCE(s.quantity,0) > 0
    GROUP BY s.asin
    HAVING count(*) >= 3
  )
  SELECT s.id, s.order_id, s.asin, s.quantity, s.sold_price, s.total_sale_amount,
         s.unit_cost, s.total_cost, s.referral_fee, s.fba_fee, s.total_fees,
         s.order_date,
         round((s.fba_fee / p.unit_fee)::numeric, 3) AS implied_units
  FROM public.sales_orders s
  JOIN per_unit p ON p.asin = s.asin
  WHERE s.user_id = p_user_id
    AND s.quantity = 1
    AND p.unit_fee > 0
    AND abs(s.fba_fee / p.unit_fee - round((s.fba_fee / p.unit_fee)::numeric)) <= 0.08
    AND round((s.fba_fee / p.unit_fee)::numeric) >= 2
    AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
  ORDER BY s.order_date DESC
  LIMIT p_limit;
$fn$;

REVOKE ALL ON FUNCTION public.collapsed_order_candidates(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collapsed_order_candidates(uuid, integer) TO service_role;

DO $verify$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 1000)
  LOOP
    RAISE NOTICE '   shortlist returns % candidate rows', r.n;
  END LOOP;
END $verify$;
