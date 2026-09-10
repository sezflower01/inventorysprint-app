-- Add marketplace to the shortlist.
--
-- The repair signed every SP-API call with one marketplace, so a batch holding
-- BR or MX orders reported them unverifiable instead of repairing them -- 6 of
-- the first 12. The row already knows which marketplace it belongs to; it just
-- was not being returned.

DROP FUNCTION IF EXISTS public.collapsed_order_candidates(uuid, integer);

CREATE OR REPLACE FUNCTION public.collapsed_order_candidates(
  p_user_id uuid,
  p_limit integer DEFAULT 25,
  p_marketplace text DEFAULT NULL
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
  ORDER BY s.order_date DESC
  LIMIT p_limit;
$fn$;

REVOKE ALL ON FUNCTION public.collapsed_order_candidates(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collapsed_order_candidates(uuid, integer, text) TO service_role;

DO $verify$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '   shortlist by marketplace:';
  FOR r IN
    SELECT marketplace, count(*) AS n
    FROM public.collapsed_order_candidates(v_uid, 5000)
    GROUP BY marketplace ORDER BY n DESC
  LOOP
    RAISE NOTICE '      % : % rows', rpad(r.marketplace,4), r.n;
  END LOOP;
END $verify$;
