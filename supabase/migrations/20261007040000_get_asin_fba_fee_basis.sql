-- One definition of "what will Amazon's fulfilment fee actually be".
--
-- THE PROBLEM, measured 2026-10-07 across 656 ASINs that have both a quote and
-- settled FBA orders. Amazon's Product Fees API quote under-states what Amazon
-- then bills, and the error grows with the fee:
--
--   billed band     ASINs   quoted   billed    gap
--   under $4          186    $3.59    $3.52   -$0.08
--   $4 - 5.99         362    $4.69    $4.76   +$0.07
--   $6 - 8.99         100    $6.23    $6.78   +$0.54
--   $9 - 14.99          7    $8.48   $10.68   +$2.20
--
-- 102 ASINs under-quoted, $2,382.83 of fulfilment cost never budgeted for.
-- Ruled out: staleness (gap is $0.09-$0.17 at every cache age) and a fee-schedule
-- change (fee/unit is flat at $4.45-$4.66 across all four 2026 quarters).
--
-- The mechanism is DIMENSIONAL WEIGHT. B09N6FR8MT is 10.9 x 10.6 x 5.0 in and
-- 0.82 lb. Quoted $3.52; billed $6.72 on every one of 27 units. 578 cubic
-- inches / 139 = 4.16 lb dimensional weight, and $6.72 is the large-standard
-- rate at ~4.2 lb. The quote priced the 0.82 lb ACTUAL weight. Bulky-and-light
-- is where it bites, and on a $17 sale $3.20 is most of the margin.
--
-- WHY NOT A FEE TABLE. The obvious fix -- classify the size tier and look the
-- fee up -- does not survive the evidence: within Large Standard this seller's
-- billed fees run from $2.44 to $10.61, so the tier is far too coarse to
-- replace the number. A hardcoded 2026 table would also be wrong every January.
--
-- WHAT THIS RETURNS INSTEAD. Two things the panels can act on:
--   1. billed_*  -- what Amazon ACTUALLY charged for this ASIN, from settled
--      orders. Exact, and available for 656 ASINs today. Not a model.
--   2. dim_weight_lb vs actual_weight_lb -- enough to say "this quote looks
--      like it used actual weight on an item that will be billed on volume",
--      WITHOUT inventing a replacement figure.
--
-- The panels prefer (1) when it exists and warn with (2) when it does not. One
-- function so the analyser, the create panel and the web cannot drift -- the
-- lesson of plModel.ts and the four COG implementations.

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
    -- UNDERSTATED means: do not trust this quote. Either the invoices already
    -- disagree with it by more than rounding, or the item will be billed on
    -- volume and the quote was priced on weight.
    COALESCE(
      c.per_unit > c.qfee + 0.25,
      false
    ) OR COALESCE(
      c.per_unit IS NULL AND c.dim_lb > GREATEST(c.actual_lb, 1.0) * 1.5 AND c.dim_lb > 1.0,
      false
    ),
    CASE
      WHEN c.per_unit > c.qfee + 0.25 THEN
        format('Amazon billed $%s/unit across %s units; the quote says $%s.',
               round(c.per_unit, 2), c.units, round(c.qfee, 2))
      WHEN c.per_unit > 0 THEN
        format('Amazon billed $%s/unit across %s units.', round(c.per_unit, 2), c.units)
      WHEN c.dim_lb > GREATEST(c.actual_lb, 1.0) * 1.5 AND c.dim_lb > 1.0 THEN
        format('Bulky for its weight: %s lb of volume against %s lb actual, so Amazon bills on %s lb. A quote priced on actual weight will be too low.',
               c.dim_lb, round(c.actual_lb, 2), c.dim_lb)
      WHEN c.qfee > 0 THEN 'Amazon estimate, no sales history to check it against.'
      ELSE 'No fee available.'
    END
  FROM calc c;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.get_asin_fba_fee_basis(text, text) TO authenticated;

COMMENT ON FUNCTION public.get_asin_fba_fee_basis(text, text) IS
  'What Amazon will actually charge to fulfil one unit: the billed fee from settled FBA orders when there is one, otherwise the Product Fees API quote plus a dimensional-weight cross-check. Single definition shared by both extension panels and the web.';

-- Sanity: the three cases, against real rows.
DO $p$
DECLARE r record;
BEGIN
  -- Only the uid claim, deliberately NOT a role switch: becoming
  -- `authenticated` inside the migration transaction also strips the runner's
  -- right to record the migration afterwards, which fails the whole push.
  PERFORM set_config('request.jwt.claim.sub',
    (SELECT id::text FROM auth.users WHERE email = 'sezflower01@gmail.com'), true);

  FOR r IN SELECT * FROM public.get_asin_fba_fee_basis('B09N6FR8MT', 'US') LOOP
    RAISE NOTICE 'B09N6FR8MT (the worked example): basis=% use=$% billed=$% quoted=$% actual=% lb dim=% lb tier=% understated=%',
      r.basis, r.fee_to_use, r.billed_fee_per_unit, r.quoted_fee,
      r.actual_weight_lb, r.dim_weight_lb, r.size_tier, r.understated;
    RAISE NOTICE '  note: %', r.note;
  END LOOP;

  FOR r IN SELECT * FROM public.get_asin_fba_fee_basis('B09431H87C', 'US') LOOP
    RAISE NOTICE 'B09431H87C (no history, no fee cache): basis=% use=% understated=%',
      r.basis, COALESCE(r.fee_to_use::text, 'NULL'), r.understated;
    RAISE NOTICE '  note: %', r.note;
  END LOOP;
END
$p$;
