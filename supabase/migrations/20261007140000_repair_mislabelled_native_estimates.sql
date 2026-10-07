-- Repair the estimates that were written while the snapshot was mislabelled.
--
-- 20261007120000 corrected the currency TAG and the code now reads it properly,
-- but the screen still showed $14.56. The reason is in fetch-live-orders Tier B:
-- it computes an estimate only `if (!estimatedPrice)`. Order
-- 702-5492481-4068251 already had one -- the wrong one -- so every sync since
-- has walked past it. Other orders were touched at 16:22 while this row's
-- updated_at sat at 13:12.
--
-- A fix that stops new damage and leaves the existing damage on screen is not a
-- fix from the seller's side. So: re-derive the affected estimates once, here,
-- using exactly the rule the code uses.
--
--   estimated_price is NATIVE marketplace currency for non-US.
--   An inventory-derived snapshot is USD.
--   native = usd * fx_rates(USD -> native)
--
-- Scoped as narrowly as the evidence supports: only rows whose estimate came
-- from seller_derived_snapshot, backed by an inventory-derived snapshot, on a
-- non-US marketplace, still unsettled. listings_api and seller_derived_repricer
-- estimates are NOT touched -- their CA/MX values (CA$80, MX$596) are already
-- plausible native figures, so "correcting" them would be the same mistake in
-- the other direction.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== before ==';
  FOR r IN
    SELECT so.order_id, so.marketplace, so.estimated_price, s.snapshot_item_price,
           s.snapshot_source, fx.rate,
           round((so.estimated_price * fx.rate)::numeric, 2) AS will_become
    FROM public.sales_orders so
    JOIN public.order_price_snapshots s
      ON s.user_id = so.user_id AND s.order_id = so.order_id AND s.asin = so.asin
    JOIN public.fx_rates fx
      ON fx.base = 'USD'
     AND fx.quote = CASE upper(so.marketplace) WHEN 'CA' THEN 'CAD'
                                               WHEN 'MX' THEN 'MXN'
                                               WHEN 'BR' THEN 'BRL' END
    WHERE upper(COALESCE(so.marketplace, '')) IN ('CA','MX','BR')
      AND so.price_calc_mode = 'seller_derived_snapshot'
      AND s.snapshot_source ILIKE '%inventory%'
      AND COALESCE(so.sold_price, 0) = 0
      AND COALESCE(so.estimated_price, 0) > 0
      AND COALESCE(so.is_cancelled, false) = false
  LOOP
    RAISE NOTICE '  % | % | est % (snapshot % %) | x% -> %',
      r.order_id, r.marketplace, r.estimated_price, r.snapshot_item_price,
      r.snapshot_source, r.rate, r.will_become;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (nothing matches -- no repair needed)'; END IF;
END
$p$;

WITH target AS (
  SELECT so.id,
         round((so.estimated_price * fx.rate)::numeric, 2) AS native_price
  FROM public.sales_orders so
  JOIN public.order_price_snapshots s
    ON s.user_id = so.user_id AND s.order_id = so.order_id AND s.asin = so.asin
  JOIN public.fx_rates fx
    ON fx.base = 'USD'
   AND fx.quote = CASE upper(so.marketplace) WHEN 'CA' THEN 'CAD'
                                             WHEN 'MX' THEN 'MXN'
                                             WHEN 'BR' THEN 'BRL' END
  WHERE upper(COALESCE(so.marketplace, '')) IN ('CA','MX','BR')
    AND so.price_calc_mode = 'seller_derived_snapshot'
    AND s.snapshot_source ILIKE '%inventory%'
    AND COALESCE(so.sold_price, 0) = 0
    AND COALESCE(so.estimated_price, 0) > 0
    AND COALESCE(so.is_cancelled, false) = false
)
UPDATE public.sales_orders so
SET estimated_price = t.native_price,
    -- Say that this figure was repaired rather than computed by the normal
    -- path, so the next person reading the row knows which rule produced it.
    price_source = 'seller_derived:snapshot:currency_repair'
FROM target t
WHERE so.id = t.id;

DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '== after ==';
  FOR r IN
    SELECT order_id, marketplace, estimated_price, price_source
    FROM public.sales_orders
    WHERE price_source = 'seller_derived:snapshot:currency_repair'
  LOOP
    RAISE NOTICE '  % | % | est % | %', r.order_id, r.marketplace, r.estimated_price, r.price_source;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no rows were changed)'; END IF;

  -- The CA order, end to end, so the number on the screen is predicted rather
  -- than hoped for: native CA$29.57 / 1.425 = US$20.75.
  FOR r IN
    SELECT so.estimated_price AS native, fx.rate,
           round((so.estimated_price / fx.rate)::numeric, 2) AS usd
    FROM public.sales_orders so
    JOIN public.fx_rates fx ON fx.base = 'USD' AND fx.quote = 'CAD'
    WHERE so.order_id = '702-5492481-4068251'
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '  702-5492481-4068251: stored CA$% / % = US$% on screen',
      r.native, r.rate, r.usd;
    RAISE NOTICE '  Amazon says CA$34.13 = about US$24. The remaining gap is the';
    RAISE NOTICE '  estimator using the US list price as a stand-in for the CA one,';
    RAISE NOTICE '  which is a separate problem from the currency label.';
  END LOOP;
END
$p$;
