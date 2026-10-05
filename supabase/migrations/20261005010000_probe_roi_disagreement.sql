-- READ-ONLY PROBE, and the record of what it settled.
--
-- Same ASIN, same $52.95, two ROIs: the analyser said 49%, the create panel
-- said 66%. Working backwards from each screen, the only free variable is the
-- fee:
--   create:   52.95 - fees - 25.63 = 16.91  ->  fees = $10.41
--   analyser: 52.95 - fees - 25.63 = 12.56  ->  fees = $14.76
-- a $4.35 gap.
--
-- ANSWERED FROM THE CODE, not from this probe: both screens read the same
-- `fees` object from fetch-listing-snapshot, which asks Amazon's Product Fees
-- API to estimate at the CURRENT MARKET PRICE it just read, not at the price
-- the seller intends to charge. The analyser rescales the referral portion to
-- the price being tested (computeWebStyleRoi / renderSellers in
-- extension/panel.js); the create panel used the estimate raw. Solving
--   referral * (52.95 / refPrice - 1) = 4.35   with referral = 0.15 * refPrice
-- gives refPrice = $23.95, which makes FBA + closing $6.82 on BOTH screens --
-- so the two never disagreed about the FBA fee at all. The entire gap was
-- referral: $3.59 (15% of the $23.95 market price) against $7.94 (15% of the
-- $52.95 sale). Amazon bills referral on the sale, so the analyser was right
-- and 66% was never achievable. Fixed in extension-create/panel.js
-- (feesAtPrice()), which now rescales exactly as the analyser does.
--
-- This probe stays as the evidence for the one thing code reading cannot tell
-- us: whether either screen had a MEASURED fee to work from, or whether both
-- were on the live estimate. If a measured row existed, the right fix would
-- have been to prefer it over the estimate instead.
--
-- SKU from the create panel: MX5-VZ0-LVZH.

DO $p$
DECLARE v_uid uuid; r record; v_asin text; v_price numeric := 52.95; v_cog numeric := 25.63;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT asin INTO v_asin FROM public.inventory
  WHERE user_id = v_uid AND sku = 'MX5-VZ0-LVZH' LIMIT 1;
  IF v_asin IS NULL THEN
    SELECT asin INTO v_asin FROM public.created_listings
    WHERE user_id = v_uid AND sku = 'MX5-VZ0-LVZH' LIMIT 1;
  END IF;
  RAISE NOTICE 'SKU MX5-VZ0-LVZH -> ASIN %', COALESCE(v_asin, '(not found)');
  IF v_asin IS NULL THEN RETURN; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== fee cache for this ASIN, every marketplace ==';
  FOR r IN SELECT marketplace, referral_rate, fba_fee_fixed, fee_source,
                  is_media, last_verified_at, updated_at
           FROM public.asin_fee_cache
           WHERE user_id = v_uid AND asin = v_asin ORDER BY marketplace LOOP
    RAISE NOTICE '  % | referral % pct | fba fixed $% | % | media % | verified %',
      r.marketplace, round(100 * r.referral_rate, 2), round(r.fba_fee_fixed, 2),
      r.fee_source, r.is_media, r.last_verified_at;
    RAISE NOTICE '      at $%: referral $% + fba $% = $% -> profit $% -> ROI % pct',
      v_price,
      round((v_price * r.referral_rate)::numeric, 2),
      round(r.fba_fee_fixed::numeric, 2),
      round((v_price * r.referral_rate + r.fba_fee_fixed)::numeric, 2),
      round((v_price - v_price * r.referral_rate - r.fba_fee_fixed - v_cog)::numeric, 2),
      round((100 * (v_price - v_price * r.referral_rate - r.fba_fee_fixed - v_cog) / v_cog)::numeric, 1);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no fee cache row at all -- both screens were on the live estimate)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what fees have REAL orders of this ASIN carried? ==';
  FOR r IN SELECT quantity, count(*) AS orders,
                  round(avg(sold_price)::numeric, 2) AS avg_price,
                  round(avg(referral_fee / NULLIF(quantity, 0))::numeric, 2) AS referral_per_unit,
                  round(avg(fba_fee / NULLIF(quantity, 0))::numeric, 2) AS fba_per_unit,
                  round(avg(total_fees / NULLIF(quantity, 0))::numeric, 2) AS fees_per_unit,
                  string_agg(DISTINCT COALESCE(fulfillment_channel, '?'), ',') AS channels,
                  string_agg(DISTINCT COALESCE(fees_source, '?'), ',') AS sources
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = v_asin
             AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
             AND COALESCE(total_fees, 0) > 0
           GROUP BY quantity ORDER BY quantity LOOP
    RAISE NOTICE '  qty % | % orders | $%/unit sold | referral $% + fba $% = $% | % | %',
      r.quantity, r.orders, r.avg_price, r.referral_per_unit, r.fba_per_unit,
      r.fees_per_unit, r.channels, r.sources;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (never sold -- no measured fees)'; END IF;
END
$p$;
