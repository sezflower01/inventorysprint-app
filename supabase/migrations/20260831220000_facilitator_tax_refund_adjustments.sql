-- Same settlement-retention gap, on the refunds line.
--
-- 20260831200000 seeded the facilitator TAX for January and February, and left
-- facilitator tax REFUNDS untouched -- so that line still reads $0.00 for
-- January and $38.93 for February against InventoryLab's $341.72 and $324.04.
-- Half a fix is its own kind of wrong: the tax line now looks complete while
-- the refund line beside it silently is not.
--
-- Same evidence standard as the tax seed. Over the six months both sources
-- fully cover: this app $1,951.13, InventoryLab $1,923.34 -- 1.4% apart. Amazon
-- data, checked rather than assumed.
--
-- Feb takes the REMAINDER (324.04 - 38.93 = 285.11), not the full figure, for
-- the same reason as the tax seed: settlements already hold 2026-02-25 onward.
--
-- A column rather than a second row: one adjustment row per month per source
-- keeps the unique constraint meaningful and the table readable. The function
-- signature is unchanged, so CREATE OR REPLACE is safe here (no 42P13).

ALTER TABLE public.facilitator_tax_adjustments
  ADD COLUMN IF NOT EXISTS refund_amount numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.facilitator_tax_adjustments.refund_amount IS
  'Facilitator tax REVERSED on refunds, for months settlement_line_items cannot cover. Feeds the Marketplace Facilitator Tax Refunds line; separate from `amount`, which feeds the tax line.';

CREATE OR REPLACE FUNCTION public.get_monthly_facilitator_tax(
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
  adj AS (
    SELECT
      EXTRACT(MONTH FROM a.period_month)::int AS m,
      SUM(a.amount) AS amount,
      SUM(a.refund_amount) AS refund_amount
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
    COALESCE(b.reversed, 0) + COALESCE(a.refund_amount, 0) AS facilitator_tax_refunds,
    COALESCE(a.amount, 0) + COALESCE(a.refund_amount, 0) AS adjustment
  FROM months
  LEFT JOIN (
    SELECT m,
           SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS withheld,
           SUM(CASE WHEN amount > 0 THEN  amount ELSE 0 END) AS reversed
    FROM base GROUP BY m
  ) b ON b.m = months.m
  LEFT JOIN adj a ON a.m = months.m
  ORDER BY months.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_facilitator_tax(integer, text) TO authenticated, service_role;

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

  SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)
    INTO v_feb_have
    FROM public.settlement_line_items
   WHERE user_id = v_user
     AND amount_type = 'ItemWithheldTax'
     AND posted_date >= DATE '2026-02-01' AND posted_date < DATE '2026-03-01';

  UPDATE public.facilitator_tax_adjustments
     SET refund_amount = 341.72, updated_at = now()
   WHERE user_id = v_user AND period_month = DATE '2026-01-01' AND source = 'inventorylab';

  UPDATE public.facilitator_tax_adjustments
     SET refund_amount = ROUND(324.04 - v_feb_have, 2), updated_at = now()
   WHERE user_id = v_user AND period_month = DATE '2026-02-01' AND source = 'inventorylab';

  RAISE NOTICE 'Refund adjustments seeded: Jan 341.72, Feb remainder % (settlements already held %).',
    to_char(ROUND(324.04 - v_feb_have, 2), 'FM999,990.00'), to_char(v_feb_have, 'FM999,990.00');
END $$;
