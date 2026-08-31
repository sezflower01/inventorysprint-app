-- Manual adjustments for marketplace facilitator tax, and a seed for the
-- settlement-retention gap.
--
-- ── THE GAP ───────────────────────────────────────────────────────────────
--
-- get_monthly_facilitator_tax (20260831180000) reads settlement_line_items,
-- which is the only place Amazon puts this data for this account. Settlement
-- documents age out: the archive starts 2026-02-25, so January is absent and
-- February holds four days of twenty-eight. Roughly $12,200 of tax Amazon
-- really did remit cannot be evidenced from that source, and the boundary keeps
-- moving forward.
--
-- ── WHY INVENTORYLAB IS TRUSTED HERE, HAVING BEEN DISTRUSTED ELSEWHERE ────
--
-- The user's standing instruction is that InventoryLab is wrong on most
-- non-Amazon data. This is Amazon data, and it was checked rather than assumed.
-- Over the six months where BOTH sources have full coverage:
--
--   InventoryLab  $38,154.36     settlements  $38,346.64     0.5% apart
--
-- Two independently built pipelines reading one Amazon account and landing
-- within half a percent. On that basis its January ($6,885.16) and February
-- ($6,268.60) figures are the best available evidence for months Amazon will no
-- longer serve.
--
-- ── WHY A SEPARATE TABLE, NOT SEEDED ROWS ────────────────────────────────
--
-- The obvious shortcut is to insert synthetic rows into settlement_line_items.
-- That would make an estimate indistinguishable from Amazon's own record, and
-- every later reconciliation would silently include it as though Amazon had
-- reported it. Adjustments live apart, carry their source, and can be removed
-- in one statement if a better figure appears -- e.g. from Seller Central's
-- Sales Tax Report, which retains longer and is what a filing actually needs.
--
-- INFORMATIONAL ONLY. Sales tax is a liability passing through the business.
-- Nothing here can move Net Profit, and nothing here should.

CREATE TABLE IF NOT EXISTS public.facilitator_tax_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  -- First day of the month the adjustment belongs to.
  period_month date NOT NULL,
  -- Positive = additional tax withheld/remitted that the settlement archive
  -- cannot show. Negative is allowed so an over-count can be corrected.
  amount       numeric NOT NULL,
  -- Where the number came from. Never blank: an unattributed adjustment is
  -- indistinguishable from a typo six months later.
  source       text NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facilitator_tax_adjustments_month_start CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT facilitator_tax_adjustments_source_nonblank CHECK (length(btrim(source)) > 0),
  CONSTRAINT facilitator_tax_adjustments_uniq UNIQUE (user_id, period_month, source)
);

COMMENT ON TABLE public.facilitator_tax_adjustments IS
  'Manual top-ups for marketplace facilitator tax in months settlement_line_items cannot cover (Amazon settlement retention). Informational only; never affects Net Profit.';

ALTER TABLE public.facilitator_tax_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS facilitator_tax_adjustments_own ON public.facilitator_tax_adjustments;
CREATE POLICY facilitator_tax_adjustments_own ON public.facilitator_tax_adjustments
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_facilitator_tax_adj_user_month
  ON public.facilitator_tax_adjustments (user_id, period_month);

-- Fold adjustments into the monthly figure.
--
-- DROP first: adding the adjustment column changes the return type, and
-- CREATE OR REPLACE cannot do that (42P13). Same restriction that forced the
-- drop-and-recreate in 20260831140000.
DROP FUNCTION IF EXISTS public.get_monthly_facilitator_tax(integer, text);

CREATE FUNCTION public.get_monthly_facilitator_tax(
  p_year integer,
  p_marketplace text
)
RETURNS TABLE(month_num integer, facilitator_tax numeric, facilitator_tax_refunds numeric, adjustment numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT
      EXTRACT(MONTH FROM s.posted_date)::int AS m,
      s.amount
    FROM public.settlement_line_items s
    WHERE s.user_id = auth.uid()
      AND s.amount_type = 'ItemWithheldTax'
      AND s.posted_date >= make_date(p_year, 1, 1)
      AND s.posted_date <  make_date(p_year + 1, 1, 1)
      AND COALESCE(s.amount, 0) <> 0
      AND (
        NULLIF(UPPER(COALESCE(p_marketplace,'')),'') IS NULL
        OR UPPER(p_marketplace) = 'ALL'
        OR (UPPER(p_marketplace) = 'US' AND (s.marketplace_name IS NULL OR s.marketplace_name ILIKE '%amazon.com'))
        OR (UPPER(p_marketplace) = 'CA' AND s.marketplace_name ILIKE '%amazon.ca')
        OR (UPPER(p_marketplace) = 'MX' AND s.marketplace_name ILIKE '%amazon.com.mx')
        OR (UPPER(p_marketplace) = 'BR' AND s.marketplace_name ILIKE '%amazon.com.br')
      )
  ),
  -- Adjustments are US-scoped: the seeded figures come from InventoryLab, which
  -- reports the US business only. Showing them under CA/MX/BR would attribute
  -- US tax to marketplaces it did not come from.
  adj AS (
    SELECT
      EXTRACT(MONTH FROM a.period_month)::int AS m,
      SUM(a.amount) AS amount
    FROM public.facilitator_tax_adjustments a
    WHERE a.user_id = auth.uid()
      AND a.period_month >= make_date(p_year, 1, 1)
      AND a.period_month <  make_date(p_year + 1, 1, 1)
      AND COALESCE(UPPER(NULLIF(p_marketplace, '')), 'ALL') IN ('ALL', 'US')
    GROUP BY 1
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(b.withheld, 0) + COALESCE(a.amount, 0) AS facilitator_tax,
    COALESCE(b.reversed, 0) AS facilitator_tax_refunds,
    -- Surfaced separately so the manual portion is never mistaken for
    -- something Amazon reported.
    COALESCE(a.amount, 0) AS adjustment
  FROM months
  LEFT JOIN (
    SELECT m,
           SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS withheld,
           SUM(CASE WHEN amount > 0 THEN  amount ELSE 0 END) AS reversed
    FROM base GROUP BY m
  ) b ON b.m = months.m
  LEFT JOIN adj a ON a.m = months.m
  GROUP BY months.m, b.withheld, b.reversed, a.amount
  ORDER BY months.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_facilitator_tax(integer, text) TO authenticated, service_role;

-- Seed the two months Amazon can no longer serve.
--
-- January: no settlement coverage at all, so InventoryLab's figure stands alone.
-- February: settlements hold 2026-02-25 onward ($755.91 of a 28-day month), so
-- the adjustment is the REMAINDER, not the total. Adding $6,268.60 on top of
-- $755.91 would report $7,024.51 for a month InventoryLab puts at $6,268.60.
DO $$
DECLARE
  v_user uuid;
  v_feb_have numeric;
BEGIN
  SELECT user_id INTO v_user
    FROM public.settlement_line_items
   WHERE amount_type = 'ItemWithheldTax'
   GROUP BY user_id ORDER BY count(*) DESC LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE 'No settlement owner found -- nothing seeded.';
    RETURN;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0)
    INTO v_feb_have
    FROM public.settlement_line_items
   WHERE user_id = v_user
     AND amount_type = 'ItemWithheldTax'
     AND posted_date >= DATE '2026-02-01' AND posted_date < DATE '2026-03-01';

  INSERT INTO public.facilitator_tax_adjustments (user_id, period_month, amount, source, note)
  VALUES
    (v_user, DATE '2026-01-01', 6885.16, 'inventorylab',
     'January 2026. No settlement coverage — archive begins 2026-02-25. InventoryLab agreed with settlements to 0.5% over the six months both cover.'),
    (v_user, DATE '2026-02-01', ROUND(6268.60 - v_feb_have, 2), 'inventorylab',
     'February 2026 remainder. Settlements cover 2026-02-25 onward only; this tops that partial month up to InventoryLab''s figure.')
  ON CONFLICT (user_id, period_month, source) DO UPDATE
    SET amount = EXCLUDED.amount, note = EXCLUDED.note, updated_at = now();

  RAISE NOTICE 'Seeded Jan (6,885.16) and Feb remainder (%) from InventoryLab.', to_char(ROUND(6268.60 - v_feb_have, 2), 'FM999,990.00');
  RAISE NOTICE 'Remove with: DELETE FROM facilitator_tax_adjustments WHERE source = ''inventorylab'';';
END $$;
