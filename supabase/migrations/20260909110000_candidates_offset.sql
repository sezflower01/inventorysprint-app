-- Add an offset to the shortlist so a sweep can page through it.
--
-- WHY. A repaired row leaves the shortlist by itself -- its quantity is no
-- longer 1. An ALREADY-CORRECT row does not: quantity is still 1 and the fee
-- ratio is still near-integer, it simply turned out to be a genuine single-unit
-- sale whose FBA fee happens to sit at twice the ASIN median.
--
-- Measured: of the first 20 candidates, 10 were already correct. Without an
-- offset every run would re-check that same head, spend the SP-API budget on
-- rows it has already cleared, and never reach the tail.

-- Drop the 3-arg version first. Adding a 4th defaulted parameter does not
-- replace it -- it creates an overload, and a 2-arg call then matches both and
-- fails with "function is not unique".
DROP FUNCTION IF EXISTS public.collapsed_order_candidates(uuid, integer, text);

CREATE OR REPLACE FUNCTION public.collapsed_order_candidates(
  p_user_id uuid,
  p_limit integer DEFAULT 25,
  p_marketplace text DEFAULT NULL,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  order_id text,
  asin text,
  marketplace text,
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
  SELECT s.id, s.order_id, s.asin, COALESCE(s.marketplace,'US') AS marketplace,
         s.quantity, s.sold_price, s.total_sale_amount,
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
    AND (p_marketplace IS NULL OR COALESCE(s.marketplace,'US') = p_marketplace)
  -- order_date alone is not unique, so id breaks ties. Without a total order
  -- an OFFSET can skip or repeat rows between calls.
  ORDER BY s.order_date DESC, s.id
  LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0), 0);
$fn$;

REVOKE ALL ON FUNCTION public.collapsed_order_candidates(uuid, integer, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collapsed_order_candidates(uuid, integer, text, integer) TO service_role;

DO $verify$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP RAISE NOTICE '   % candidates remain', r.n; END LOOP;
END $verify$;
