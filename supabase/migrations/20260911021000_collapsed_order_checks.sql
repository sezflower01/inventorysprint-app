-- Record which shortlist rows have already been verified against Amazon, and
-- stop offering them again.
--
-- WHY. collapsed_order_candidates shortlists rows that MIGHT be collapsed:
-- quantity 1 with an FBA fee near a whole multiple of the ASIN's per-unit fee.
-- It has no memory. A row the repair confirms is genuinely correct still has
-- quantity 1 and still has that fee ratio, so it stays on the shortlist
-- forever. Paging with an offset only moves the problem, because the cron had
-- no way to remember where it got to between runs.
--
-- Measured before this fix: 23 consecutive runs, 1,149 SP-API calls, 0 repairs,
-- 1,046 of them re-confirming rows already confirmed.
--
-- The fix is to remember the verdict. Every outcome that is FINAL is recorded:
--   repaired          the row was corrected
--   already_correct   Amazon agrees with what is stored
--   not_found         Amazon has no such order (404); will never verify
--   asin_not_in_order the order exists but does not contain this ASIN
-- and the shortlist excludes recorded rows.
--
-- Deliberately NOT recorded, so they are retried on a later run:
--   throttled (429) -- the sweep going too fast, not a property of the order
--   other HTTP failures -- transient
--   missing seller authorisation -- a configuration problem
-- Recording those would silently drop repairable rows from the sweep for good.
--
-- Dry runs record nothing, so a preview never consumes the list.

CREATE TABLE IF NOT EXISTS public.collapsed_order_checks (
  sales_order_id uuid PRIMARY KEY
    REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  outcome        text NOT NULL
    CHECK (outcome IN ('repaired','already_correct','not_found','asin_not_in_order')),
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collapsed_order_checks_user_idx
  ON public.collapsed_order_checks (user_id, checked_at DESC);

-- Service role only: written by the repair edge function, read by the RPC,
-- never touched by the browser.
ALTER TABLE public.collapsed_order_checks ENABLE ROW LEVEL SECURITY;

-- Same signature as 20260909110000, so CREATE OR REPLACE swaps it in place --
-- no overload, no "function is not unique".
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
    -- The one new clause: a verdict already reached is not asked for again.
    AND NOT EXISTS (
      SELECT 1 FROM public.collapsed_order_checks c WHERE c.sales_order_id = s.id
    )
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
  LOOP
    RAISE NOTICE '   shortlist: % candidates (nothing recorded yet, so unchanged)', r.n;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_checks
  LOOP
    RAISE NOTICE '   collapsed_order_checks: % rows', r.n;
  END LOOP;
END $verify$;
