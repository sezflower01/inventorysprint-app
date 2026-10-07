-- Correct the currency LABEL on inventory-derived price snapshots.
--
-- order_price_snapshots carries two currency columns and they disagreed:
--
--   order 702-5492481-4068251 | CA | B002HJ4HSS | 2026-10-06
--   snapshot_item_price 20.75 | source backfill_inventory_asin
--   currency USD              | currency_code CAD
--
-- 20.75 is inventory.my_price. Inventory is a single pool shared by all four
-- marketplaces and holds USD, so `currency` (USD) described the amount
-- correctly and `currency_code` (CAD) described the MARKETPLACE.
-- backfill-order-snapshots set it that way deliberately -- "a CA order sells in
-- CAD" -- and fetch-live-orders read currency_code first, concluded the number
-- was already native, and skipped the USD->CAD conversion.
--
-- The estimate was therefore stored as 20.75 "CAD"; Live Sales converted it
-- back to USD and showed $14.56. Amazon's own screen says CA$34.13, about
-- US$24.
--
-- Not one order. Estimate against settled price over 180 days:
--   US  21,194 orders   $20.47 vs $20.50     +0.3%
--   CA     185 orders   $36.39 vs $28.13    +30.0%
--   MX     110 orders  $479.05 vs $27.73  +1630.2%
--   BR      29 orders  $148.83 vs $28.73   +421.7%
-- US is clean because USD->USD is a no-op. Every non-US marketplace is wrong in
-- BOTH directions, which is what a mislabelled unit looks like rather than a
-- bad price.
--
-- This migration only relabels; it does not invent or convert any amount. The
-- code fix in the same commit makes the reader consult the SOURCE first, so an
-- inventory-derived price is treated as USD whatever the tags say, and
-- fetch-live-orders re-derives pending estimates on its next run.

DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== before: inventory-derived snapshots whose tags contradict ==';
  FOR r IN
    SELECT snapshot_source,
           COALESCE(currency, '(null)') AS cur,
           COALESCE(currency_code, '(null)') AS code,
           count(*) AS rows
    FROM public.order_price_snapshots
    WHERE snapshot_source ILIKE '%inventory%'
    GROUP BY 1, 2, 3 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '  % | currency % | currency_code % | % rows',
      rpad(r.snapshot_source, 26), rpad(r.cur, 8), rpad(r.code, 8), r.rows;
  END LOOP;
END
$p$;

-- Only the exact contradiction: the source says inventory (therefore USD) and
-- currency_code claims something else. Rows where the two already agree, and
-- rows from genuinely native sources (pricing_api, orders_api), are untouched.
WITH fixed AS (
  UPDATE public.order_price_snapshots
  SET currency_code = 'USD',
      currency = 'USD'
  WHERE snapshot_source ILIKE '%inventory%'
    AND COALESCE(currency_code, 'USD') <> 'USD'
  RETURNING 1
)
SELECT count(*) AS rows_relabelled FROM fixed;

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO n FROM public.order_price_snapshots
  WHERE snapshot_source ILIKE '%inventory%' AND COALESCE(currency_code, 'USD') <> 'USD';
  RAISE NOTICE '';
  RAISE NOTICE 'remaining inventory-derived rows still tagged non-USD: % (must be 0)', n;

  -- What the correction is worth, WITHOUT applying it to any order row. The
  -- estimates are re-derived by fetch-live-orders on its next run; this is here
  -- so the size of the change is on the record before it happens.
  RAISE NOTICE '';
  RAISE NOTICE '== unsettled non-US orders whose estimate came from a relabelled snapshot ==';
  RAISE NOTICE '   order | mkt | stored est | should be (est x USD->native) ';
  FOR r IN
    SELECT so.order_id, so.marketplace, so.estimated_price AS stored,
           round((so.estimated_price * fx.rate)::numeric, 2) AS corrected,
           fx.rate
    FROM public.sales_orders so
    JOIN public.order_price_snapshots s
      ON s.user_id = so.user_id AND s.order_id = so.order_id AND s.asin = so.asin
    JOIN public.fx_rates fx
      ON fx.base = 'USD'
     AND fx.quote = CASE upper(so.marketplace) WHEN 'CA' THEN 'CAD'
                                               WHEN 'MX' THEN 'MXN'
                                               WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid
      AND upper(COALESCE(so.marketplace, '')) IN ('CA', 'MX', 'BR')
      AND COALESCE(so.sold_price, 0) = 0
      AND COALESCE(so.estimated_price, 0) > 0
      AND so.price_calc_mode = 'seller_derived_snapshot'
      AND s.snapshot_source ILIKE '%inventory%'
      AND COALESCE(so.is_cancelled, false) = false
    ORDER BY so.estimated_price DESC LIMIT 20
  LOOP
    RAISE NOTICE '   % | % | % | % (x%)',
      r.order_id, r.marketplace, lpad(r.stored::text, 9), lpad(r.corrected::text, 9), r.rate;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   (none -- only the CA order used this tier; the rest came from';
    RAISE NOTICE '    listings_api and seller_derived_repricer, which have their own';
    RAISE NOTICE '    currency handling and are NOT fixed by this migration)';
  END IF;
END
$p$;
