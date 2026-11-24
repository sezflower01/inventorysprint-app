-- Withdraw the dimensional-weight understatement warning.
--
-- WHAT THIS CHANGES. get_asin_fba_fee_basis set `understated` for two reasons:
-- the invoices disagreeing with the quote, and a client-side cross-check that
-- said "this item is bulky for its weight, so a quote priced on actual weight
-- will be too low". The second reason is removed. The first is kept: it
-- compares real settled fees against the quote and needs no model.
--
-- WHY. Measured 2026-11-24 over every US ASIN that has BOTH a Product Fees API
-- quote and settled FBA invoices, bucketed by dimensional weight:
--
--   * the median quote-to-invoice gap is ZERO in every dimensional-weight
--     band, including the bulkiest one, whose average volume is several times
--     its average actual weight;
--   * items over a pound AND bulky -- where dimensional weight unambiguously
--     applies -- matched their quotes to within cents across hundreds of units;
--   * the largest single gap in the whole population sits in the LEAST bulky
--     band, and that band also holds the most ASINs that were under-quoted by
--     more than a dollar.
--
-- So the gap that remains is real but is not explained by volume. The most
-- likely reading is the simplest: Amazon's Fees API already prices the weight
-- Amazon will bill, dimensional weight included, because Amazon computes both
-- from its own measurements. The cross-check was reinventing that from dims
-- which may be less accurate than Amazon's own, and then contradicting it.
--
-- WHAT THE ORIGINAL 2026-10-07 FINDING ACTUALLY SAW. Its own banded table
-- shows the large gaps confined to the two smallest buckets (single-digit and
-- low-hundreds ASIN counts) while the large majority showed gaps inside a
-- dime. "The mechanism is dimensional weight" was drawn from the thin end of
-- the distribution and does not survive bucketing by the mechanism itself.
-- The worked example in that header is a genuine outlier, not the pattern.
--
-- WHAT THIS COST IN PRACTICE. The warning fires only where there is no billed
-- history, i.e. exactly where it cannot be checked, and it turned the panel's
-- Size Tier row amber with a note naming a volume-derived weight. A light,
-- moderately bulky item -- the common shape in this catalog -- was flagged as
-- having an understated fee when the measurable members of its own bucket
-- match their quotes. Reported 2026-11-24 as "small item shown as big size".
--
-- NOT CHANGED. dim_weight_lb, actual_weight_lb, billable_weight_lb and
-- size_tier are still returned. They are useful figures and the panel still
-- shows them; only the VERDICT drawn from them is withdrawn. The unit handling
-- in the dims CTE is also untouched: every unit present in
-- asin_dimensions_cache today is one it already converts correctly (verified
-- 2026-11-24 -- the table holds only inches, centimeters, pounds and grams),
-- so widening it would be a change with no measurable effect.
--
-- The 2026-10-07 file's trailing DO block of RAISE NOTICE self-tests is not
-- carried over; it was a one-time verification against named ASINs.

CREATE OR REPLACE FUNCTION public.get_asin_fba_fee_basis(
  p_asin text, p_marketplace text DEFAULT 'US'
)
RETURNS TABLE (
  asin               text,
  marketplace        text,
  -- measured
  billed_fee_per_unit numeric,
  billed_units        integer,
  billed_orders       integer,
  billed_last_date    date,
  billed_spread       numeric,   -- max-min per-unit; a wide spread means the
                                 -- average is not a reliable single number
  -- quoted
  quoted_fee          numeric,
  referral_rate       numeric,
  quoted_at           timestamptz,
  -- size
  actual_weight_lb    numeric,
  dim_weight_lb       numeric,
  billable_weight_lb  numeric,
  size_tier           text,
  dims_source         text,
  -- the verdict
  basis               text,      -- 'billed' | 'quoted' | 'none'
  fee_to_use          numeric,
  understated         boolean,
  note                text
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_asin text := upper(btrim(COALESCE(p_asin, '')));
  v_mkt  text := upper(COALESCE(NULLIF(btrim(p_marketplace), ''), 'US'));
BEGIN
  IF v_uid IS NULL OR v_asin = '' THEN RETURN; END IF;

  RETURN QUERY
  WITH billed AS (
    -- Settled FBA orders only. order_id NOT LIKE '%-REFUND' because refund rows
    -- carry their own sign; is_cancelled because a cancelled order's fee is
    -- reversed. AFN = Amazon-fulfilled; an FBM order's fee says nothing about
    -- what FBA would cost.
    SELECT sum(so.fba_fee) / NULLIF(sum(so.quantity), 0) AS per_unit,
           sum(so.quantity)::int                         AS units,
           count(*)::int                                 AS orders,
           max(so.order_date)::date                      AS last_date,
           max(so.fba_fee / NULLIF(so.quantity, 0))
             - min(so.fba_fee / NULLIF(so.quantity, 0))  AS spread
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.asin = v_asin
      AND COALESCE(so.is_cancelled, false) = false
      AND so.order_id NOT LIKE '%-REFUND'
      AND COALESCE(so.fba_fee, 0) > 0
      AND upper(COALESCE(so.fulfillment_channel, '')) LIKE 'AFN%'
  ), quoted AS (
    SELECT fc.fba_fee_fixed::numeric AS fee, fc.referral_rate::numeric AS rate, fc.updated_at
    FROM public.asin_fee_cache fc
    WHERE fc.user_id = v_uid AND fc.asin = v_asin AND fc.marketplace = v_mkt
    ORDER BY fc.updated_at DESC LIMIT 1
  ), dims AS (
    SELECT
      -- Same unit handling as classifySizeTier() in extension/panel.js. If the
      -- two ever disagree the panel's badge and this verdict describe different
      -- objects, so they are written to match deliberately.
      d.source,
      GREATEST(d.package_length, d.package_width, d.package_height) * s.dscale AS longest,
      (d.package_length + d.package_width + d.package_height
        - GREATEST(d.package_length, d.package_width, d.package_height)
        - LEAST(d.package_length, d.package_width, d.package_height)) * s.dscale AS median,
      LEAST(d.package_length, d.package_width, d.package_height) * s.dscale AS shortest,
      d.package_weight * s.wscale AS lbs,
      (d.package_length * d.package_width * d.package_height) * s.dscale * s.dscale * s.dscale AS cubic_in
    FROM public.asin_dimensions_cache d
    CROSS JOIN LATERAL (
      SELECT
        CASE lower(COALESCE(d.package_dim_unit, 'inches'))
          WHEN 'millimeters' THEN 1/25.4 WHEN 'mm' THEN 1/25.4
          WHEN 'centimeters' THEN 1/2.54  WHEN 'cm' THEN 1/2.54
          ELSE 1 END AS dscale,
        CASE lower(COALESCE(d.package_weight_unit, 'pounds'))
          WHEN 'grams' THEN 1/453.592 WHEN 'g' THEN 1/453.592
          WHEN 'kilograms' THEN 2.20462
          WHEN 'ounces' THEN 1/16.0 WHEN 'oz' THEN 1/16.0
          ELSE 1 END AS wscale
    ) s
    WHERE d.asin = v_asin AND d.marketplace = v_mkt
      AND d.package_length > 0 AND d.package_width > 0
      AND d.package_height > 0 AND d.package_weight > 0
    LIMIT 1
  ), calc AS (
    SELECT
      b.per_unit, b.units, b.orders, b.last_date, b.spread,
      q.fee AS qfee, q.rate, q.updated_at,
      dm.lbs AS actual_lb,
      -- Amazon's US divisor is 139 for standard size. Only meaningful once the
      -- item is above the 1 lb small-standard line, which is why the warning
      -- below also requires the quote to look like an actual-weight quote.
      CASE WHEN dm.cubic_in > 0 THEN round((dm.cubic_in / 139.0)::numeric, 2) END AS dim_lb,
      dm.source AS dsource,
      CASE
        WHEN dm.longest IS NULL THEN NULL
        WHEN dm.longest <= 15 AND dm.median <= 12 AND dm.shortest <= 0.75 AND dm.lbs <= 1  THEN 'Small Standard'
        WHEN dm.longest <= 18 AND dm.median <= 14 AND dm.shortest <= 8    AND dm.lbs <= 20 THEN 'Large Standard'
        WHEN dm.longest <= 60  AND dm.longest + 2*(dm.median + dm.shortest) <= 130 AND dm.lbs <= 50 THEN 'Large Oversize'
        WHEN dm.longest <= 108 AND dm.longest + 2*(dm.median + dm.shortest) <= 165 THEN 'Oversize'
        ELSE 'Heavy/Bulky'
      END AS tier
    FROM billed b
    FULL JOIN quoted q ON true
    LEFT JOIN dims dm ON true
  )
  SELECT
    v_asin, v_mkt,
    round(c.per_unit, 2), c.units, c.orders, c.last_date, round(c.spread, 2),
    round(c.qfee, 2), c.rate, c.updated_at,
    round(c.actual_lb, 2), c.dim_lb,
    round(GREATEST(COALESCE(c.actual_lb, 0), COALESCE(c.dim_lb, 0))::numeric, 2),
    c.tier, c.dsource,
    CASE WHEN c.per_unit > 0 THEN 'billed' WHEN c.qfee > 0 THEN 'quoted' ELSE 'none' END,
    round(COALESCE(NULLIF(c.per_unit, 0), c.qfee), 2),
    -- UNDERSTATED means one thing now: the invoices already disagree with this
    -- quote by more than rounding. The second clause -- "bulky for its weight,
    -- so the quote priced the wrong weight" -- was withdrawn 2026-11-24; the
    -- header records the measurement that withdrew it.
    COALESCE(c.per_unit > c.qfee + 0.25, false),
    CASE
      WHEN c.per_unit > c.qfee + 0.25 THEN
        format('Amazon billed $%s/unit across %s units; the quote says $%s.',
               round(c.per_unit, 2), c.units, round(c.qfee, 2))
      WHEN c.per_unit > 0 THEN
        format('Amazon billed $%s/unit across %s units.', round(c.per_unit, 2), c.units)
      WHEN c.qfee > 0 THEN 'Amazon estimate, no sales history to check it against.'
      ELSE 'No fee available.'
    END
  FROM calc c;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.get_asin_fba_fee_basis(text, text) TO authenticated;

COMMENT ON FUNCTION public.get_asin_fba_fee_basis(text, text) IS
  'What Amazon will actually charge to fulfil one unit: the billed fee from settled FBA orders when there is one, otherwise the Product Fees API quote. Reports actual, dimensional and billable weight for context, but draws no understatement verdict from them -- see the 2026-11-24 migration. Single definition shared by both extension panels and the web.';
