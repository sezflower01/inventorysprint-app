-- Only claim a dimensional weight where the /139 rule actually applies.
--
-- The contract probe (20261007050000) surfaced a claim I would not want a
-- seller to act on. B0CBXV2268 has a 40 lb actual weight and cached package
-- dimensions that work out to 287.77 lb of "volume", and the note said
-- flatly: "Amazon bills on 287.77 lb". Nothing bills on 287.77 lb. Either the
-- cached dimensions are wrong, or the item is oversize -- and Amazon does not
-- price oversize on the standard 139 divisor anyway.
--
-- A warning that prints an absurd number teaches the seller to ignore
-- warnings, which costs more than the warning saves. So the dimensional-weight
-- claim is now made ONLY for Small/Large Standard, where 139 is the right
-- divisor and the arithmetic is checkable; oversize items get a plain
-- "estimate may not hold" without an invented figure.
--
-- Also stops billable_weight_lb reporting 0.00 for an ASIN we know nothing
-- about -- null means unknown, 0.00 reads as "weighs nothing".

CREATE OR REPLACE FUNCTION public.get_asin_fba_fee_basis(
  p_asin text, p_marketplace text DEFAULT 'US'
)
RETURNS TABLE (
  asin               text,
  marketplace        text,
  billed_fee_per_unit numeric,
  billed_units        integer,
  billed_orders       integer,
  billed_last_date    date,
  billed_spread       numeric,
  quoted_fee          numeric,
  referral_rate       numeric,
  quoted_at           timestamptz,
  actual_weight_lb    numeric,
  dim_weight_lb       numeric,
  billable_weight_lb  numeric,
  size_tier           text,
  dims_source         text,
  basis               text,
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
      d.source,
      GREATEST(d.package_length, d.package_width, d.package_height) * s.dscale AS longest,
      (d.package_length + d.package_width + d.package_height
        - GREATEST(d.package_length, d.package_width, d.package_height)
        - LEAST(d.package_length, d.package_width, d.package_height)) * s.dscale AS median,
      LEAST(d.package_length, d.package_width, d.package_height) * s.dscale AS shortest,
      d.package_weight * s.wscale AS lbs,
      (d.package_length * d.package_width * d.package_height)
        * s.dscale * s.dscale * s.dscale AS cubic_in
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
      dm.lbs AS actual_lb, dm.source AS dsource,
      CASE
        WHEN dm.longest IS NULL THEN NULL
        WHEN dm.longest <= 15 AND dm.median <= 12 AND dm.shortest <= 0.75 AND dm.lbs <= 1  THEN 'Small Standard'
        WHEN dm.longest <= 18 AND dm.median <= 14 AND dm.shortest <= 8    AND dm.lbs <= 20 THEN 'Large Standard'
        WHEN dm.longest <= 60  AND dm.longest + 2*(dm.median + dm.shortest) <= 130 AND dm.lbs <= 50 THEN 'Large Oversize'
        WHEN dm.longest <= 108 AND dm.longest + 2*(dm.median + dm.shortest) <= 165 THEN 'Oversize'
        ELSE 'Heavy/Bulky'
      END AS tier,
      -- 139 is Amazon's US divisor for STANDARD size. Applying it to an
      -- oversize item produces a number Amazon would never bill, so it is only
      -- computed where it means something.
      CASE
        WHEN dm.cubic_in > 0
         AND dm.longest <= 18 AND dm.median <= 14 AND dm.shortest <= 8 AND dm.lbs <= 20
        THEN round((dm.cubic_in / 139.0)::numeric, 2)
      END AS dim_lb
    FROM billed b
    FULL JOIN quoted q ON true
    LEFT JOIN dims dm ON true
  )
  SELECT
    v_asin, v_mkt,
    round(c.per_unit, 2), c.units, c.orders, c.last_date, round(c.spread, 2),
    round(c.qfee, 2), c.rate, c.updated_at,
    round(c.actual_lb, 2), c.dim_lb,
    CASE WHEN c.actual_lb IS NULL AND c.dim_lb IS NULL THEN NULL
         ELSE round(GREATEST(COALESCE(c.actual_lb, 0), COALESCE(c.dim_lb, 0))::numeric, 2) END,
    c.tier, c.dsource,
    CASE WHEN c.per_unit > 0 THEN 'billed' WHEN c.qfee > 0 THEN 'quoted' ELSE 'none' END,
    round(COALESCE(NULLIF(c.per_unit, 0), c.qfee), 2),
    COALESCE(c.per_unit > c.qfee + 0.25, false)
      OR COALESCE(c.per_unit IS NULL AND c.dim_lb > GREATEST(c.actual_lb, 1.0) * 1.5 AND c.dim_lb > 1.0, false)
      OR COALESCE(c.per_unit IS NULL AND c.tier IN ('Large Oversize', 'Oversize', 'Heavy/Bulky') AND c.qfee > 0, false),
    CASE
      WHEN c.per_unit > c.qfee + 0.25 THEN
        format('Amazon billed $%s/unit across %s units; the quote says $%s.',
               round(c.per_unit, 2), c.units, round(c.qfee, 2))
      WHEN c.per_unit > 0 THEN
        format('Amazon billed $%s/unit across %s units.', round(c.per_unit, 2), c.units)
      WHEN c.dim_lb > GREATEST(c.actual_lb, 1.0) * 1.5 AND c.dim_lb > 1.0 THEN
        format('Bulky for its weight: %s lb of volume against %s lb actual, so Amazon bills on %s lb. A quote priced on actual weight will be too low.',
               c.dim_lb, round(c.actual_lb, 2), c.dim_lb)
      WHEN c.tier IN ('Large Oversize', 'Oversize', 'Heavy/Bulky') THEN
        format('%s, and oversize fees are not priced on the standard rules. Check the real fee in Seller Central before buying.', c.tier)
      WHEN c.qfee > 0 THEN 'Amazon estimate, no sales history to check it against.'
      ELSE 'No fee available.'
    END
  FROM calc c;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.get_asin_fba_fee_basis(text, text) TO authenticated;

DO $p$
DECLARE r record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    (SELECT id::text FROM auth.users WHERE email = 'sezflower01@gmail.com'), true);

  RAISE NOTICE 'B09N6FR8MT (standard, dim-weight claim is valid):';
  FOR r IN SELECT row_to_json(t) AS j FROM public.get_asin_fba_fee_basis('B09N6FR8MT', 'US') t LOOP
    RAISE NOTICE '  %', r.j;
  END LOOP;

  RAISE NOTICE 'B0CBXV2268 (the 287 lb nonsense, now refused):';
  FOR r IN SELECT size_tier, dim_weight_lb, billable_weight_lb, understated, note
           FROM public.get_asin_fba_fee_basis('B0CBXV2268', 'US') LOOP
    RAISE NOTICE '  tier=% dim=% billable=% understated=% | %',
      r.size_tier, COALESCE(r.dim_weight_lb::text, 'NULL'),
      COALESCE(r.billable_weight_lb::text, 'NULL'), r.understated, r.note;
  END LOOP;

  RAISE NOTICE 'ZZZZZZZZZZ (nothing known):';
  FOR r IN SELECT billable_weight_lb, basis, note
           FROM public.get_asin_fba_fee_basis('ZZZZZZZZZZ', 'US') LOOP
    RAISE NOTICE '  billable=% basis=% | %',
      COALESCE(r.billable_weight_lb::text, 'NULL'), r.basis, r.note;
  END LOOP;
END
$p$;
