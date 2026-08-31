-- Marketplace facilitator tax, from settlement reports.
--
-- ── WHY NOT FINANCIAL EVENTS ──────────────────────────────────────────────
--
-- The P&L reported Marketplace Facilitator Tax as $0.00 for all of 2026 while
-- InventoryLab reported $51,308.12 of tax Amazon remitted to the states on the
-- seller's behalf. Read literally, the P&L said "collected $51,852, remitted
-- nothing" -- i.e. that the seller was holding somebody else's tax money.
--
-- fetch-profit-loss has always had explicit handlers:
--
--   case 'MarketplaceFacilitatorTax-Principal':
--   case 'MarketplaceFacilitatorTax-Shipping':
--   case 'MarketplaceFacilitatorTax-Giftwrap':
--     entry.marketplace_facilitator_tax += amount;
--
-- Those cases have never matched. On 2026-08-31 the parser was extended to read
-- ItemTaxWithheldList as well, deployed, and the whole year reparsed -- still
-- $0.00. Amazon does not put this in Financial Events for this account at all.
--
-- It is in the SETTLEMENT reports, and always has been:
-- settlement_line_items.amount_type = 'ItemWithheldTax', already synced weekly
-- by auto-sync-settlements-weekly. 142,680 line items were sitting in that
-- table while the P&L displayed a zero.
--
-- Third time in one day that a handler existed, looked correct, and pointed at
-- a source Amazon never populates -- after fbm_shipping_label_fee and the
-- ItemTaxWithheldList attempt above. The lesson is the same each time: confirm
-- where the data IS before writing code that reads where it OUGHT to be.
--
-- ── SIGN SPLIT IS NOT COSMETIC ────────────────────────────────────────────
--
-- Measured: the signed sum over all time is -$37,138.16, but the sum of
-- absolute values for 2026 alone is $41,088.06. Both cannot describe one
-- quantity. The list holds two: tax WITHHELD (negative, Amazon remitting) and
-- tax REVERSED (positive, refunded to a buyer) -- about $39,113 against $1,975.
-- SUM(ABS(...)) would report $41,088 of remittance that never happened, so the
-- two are separated by sign into the two columns the P&L already renders.
--
-- ── COVERAGE ─────────────────────────────────────────────────────────────
--
-- Settlement documents have a retention window; this archive starts
-- 2026-02-25. January and most of February are not recoverable from here and
-- will read low. Everything after is real, and it is complete going forward
-- because the weekly sync keeps it current.
--
-- INFORMATIONAL ONLY. Sales tax is a liability passing through the business,
-- never income or expense; this cannot move Net Profit and must not.

CREATE OR REPLACE FUNCTION public.get_monthly_facilitator_tax(
  p_year integer,
  p_marketplace text
)
RETURNS TABLE(month_num integer, facilitator_tax numeric, facilitator_tax_refunds numeric)
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
        -- marketplace_name carries Amazon's own labels ("Amazon.com",
        -- "Amazon.ca", ...). NULL is treated as US, matching how the P&L
        -- treats an unlabelled financial event.
        OR (UPPER(p_marketplace) = 'US' AND (s.marketplace_name IS NULL OR s.marketplace_name ILIKE '%amazon.com'))
        OR (UPPER(p_marketplace) = 'CA' AND s.marketplace_name ILIKE '%amazon.ca')
        OR (UPPER(p_marketplace) = 'MX' AND s.marketplace_name ILIKE '%amazon.com.mx')
        OR (UPPER(p_marketplace) = 'BR' AND s.marketplace_name ILIKE '%amazon.com.br')
      )
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    -- Negative = withheld by Amazon and remitted. Returned positive, matching
    -- how sales_tax_collected is stored; the P&L renders it negative.
    COALESCE(SUM(CASE WHEN b.amount < 0 THEN -b.amount ELSE 0 END), 0) AS facilitator_tax,
    -- Positive = reversed on a refund.
    COALESCE(SUM(CASE WHEN b.amount > 0 THEN  b.amount ELSE 0 END), 0) AS facilitator_tax_refunds
  FROM months
  LEFT JOIN base b ON b.m = months.m
  GROUP BY months.m
  ORDER BY months.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_facilitator_tax(integer, text) TO authenticated, service_role;

DO $$
DECLARE v_tax NUMERIC; v_ref NUMERIC; v_from DATE;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN amount > 0 THEN  amount ELSE 0 END), 0),
         MIN(posted_date)::date
    INTO v_tax, v_ref, v_from
    FROM public.settlement_line_items
   WHERE amount_type = 'ItemWithheldTax'
     AND posted_date >= make_date(EXTRACT(YEAR FROM now())::int, 1, 1);
  RAISE NOTICE 'get_monthly_facilitator_tax created. % withheld, % reversed this year, from % onward.',
    to_char(v_tax, 'FM999,999,990.00'), to_char(v_ref, 'FM999,999,990.00'), v_from;
  RAISE NOTICE 'Informational only -- Net Profit must not move.';
END $$;
