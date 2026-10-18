-- Write the three prices VERIFIED against Seller Central, replacing estimates.
--
-- These are not reverts to the previous estimate -- they are the real prices
-- the seller read off Amazon's own order pages, which is the only ground truth
-- available before settlement:
--
--   702-6705125-8817807  MX  B003F35R34  q3   MX$392.30 / unit
--   702-5492481-4068251  CA  B002HJ4HSS  q1   CA$34.13
--   701-1848920-5681843  CA  B00DLD1C0A  q2   CA$39.08 / unit
--
-- All three are per-unit, matching the estimated_price contract (NATIVE
-- marketplace currency, per unit). Quantities are left untouched.
--
-- LABELLING. locked_from carries a UNIQUE suffix so the write satisfies the
-- preserve_manual_price_override trigger, which now requires locked_from to
-- CHANGE to a manual label -- an inherited label no longer passes. price_source
-- is the stable manual:amazon_verified, which matters because
-- isLowConfidenceHint in src/lib/salesCalculations.ts is a BLOCKLIST: this
-- prefix matches nothing on it, so the value counts in Live Sales. (Naming it
-- estimated:keepa* or pricing_api* would have silently excluded it.)
--
-- price_confidence stays HIGH_CONFIDENCE_PENDING rather than CONFIRMED on
-- purpose: sold_price is still 0, and CONFIRMED carries meaning elsewhere --
-- learnedFeeMultipliers treats it as a hard do-not-touch. The provenance lives
-- in price_source instead.
--
-- Settlement still wins: the trigger releases the override the moment
-- sold_price or total_sale_amount goes positive, so Amazon's settled figure
-- will replace these without a fight.

CREATE TABLE IF NOT EXISTS public.backup_amazon_verified_prices_20261018 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);

COMMENT ON TABLE public.backup_amazon_verified_prices_20261018 IS
  'Full pre-change snapshot of the three sales_orders rows overwritten on 2026-10-18 with prices verified against Seller Central. Restore from row_data if a verified price turns out to be misread.';

INSERT INTO public.backup_amazon_verified_prices_20261018 (reason, row_data)
SELECT 'pre_amazon_verified_write', to_jsonb(so)
FROM public.sales_orders so
WHERE so.order_id IN ('702-6705125-8817807','702-5492481-4068251','701-1848920-5681843');

-- BEFORE
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT count(*) INTO n FROM public.backup_amazon_verified_prices_20261018;
  RAISE NOTICE '== BACKUP: % rows saved ==', n;
  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE: Live Sales contribution per order ==';
  FOR r IN
    SELECT so.order_id, so.marketplace AS mk, so.asin, so.quantity AS qty,
           so.estimated_price AS est, fx.rate AS fx,
           round((so.estimated_price * so.quantity / fx.rate)::numeric, 2) AS usd,
           COALESCE(so.price_source,'-') AS src, COALESCE(so.locked_from,'-') AS lf
    FROM public.sales_orders so
    JOIN public.fx_rates fx ON fx.base = 'USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid
      AND so.order_id IN ('702-6705125-8817807','702-5492481-4068251','701-1848920-5681843')
    ORDER BY so.order_id
  LOOP
    RAISE NOTICE '   % % % q% | est % x % / % = US$%',
      rpad(r.mk,3), r.order_id, r.asin, r.qty, r.est, r.qty, r.fx, r.usd;
    RAISE NOTICE '        src % | lock %', r.src, r.lf;
  END LOOP;
END
$p$;

-- THE WRITES. One statement per order so a misread value is easy to isolate
-- and revert from the backup.
UPDATE public.sales_orders
SET estimated_price  = 392.30,
    locked_est_price = 392.30,
    locked_from      = 'manual:amazon_verified@20261018T1',
    price_source     = 'manual:amazon_verified',
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_fee_enrich = true,   -- referral is a pct of price, so it must requote
    next_enrich_after = NULL,
    updated_at       = now()
WHERE order_id = '702-6705125-8817807' AND COALESCE(sold_price,0) = 0;

UPDATE public.sales_orders
SET estimated_price  = 34.13,
    locked_est_price = 34.13,
    locked_from      = 'manual:amazon_verified@20261018T2',
    price_source     = 'manual:amazon_verified',
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_fee_enrich = true,
    next_enrich_after = NULL,
    updated_at       = now()
WHERE order_id = '702-5492481-4068251' AND COALESCE(sold_price,0) = 0;

UPDATE public.sales_orders
SET estimated_price  = 39.08,
    locked_est_price = 39.08,
    locked_from      = 'manual:amazon_verified@20261018T3',
    price_source     = 'manual:amazon_verified',
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_fee_enrich = true,
    next_enrich_after = NULL,
    updated_at       = now()
WHERE order_id = '701-1848920-5681843' AND COALESCE(sold_price,0) = 0;

-- AFTER
DO $p$
DECLARE v_uid uuid; r record; v_before numeric := 0; v_after numeric := 0; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '== AFTER: per order, before -> after Live Sales (USD) ==';
  FOR r IN
    SELECT so.order_id, so.marketplace AS mk, so.asin, so.quantity AS qty,
           (b.row_data->>'estimated_price')::numeric AS old_est,
           so.estimated_price AS new_est, fx.rate AS fx,
           round(((b.row_data->>'estimated_price')::numeric * so.quantity / fx.rate)::numeric,2) AS usd_before,
           round((so.estimated_price * so.quantity / fx.rate)::numeric,2) AS usd_after,
           COALESCE(so.price_source,'-') AS src, COALESCE(so.locked_from,'-') AS lf,
           COALESCE(so.price_confidence,'-') AS conf
    FROM public.sales_orders so
    JOIN public.backup_amazon_verified_prices_20261018 b
      ON b.row_data->>'order_id' = so.order_id
    JOIN public.fx_rates fx ON fx.base = 'USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid
      AND so.order_id IN ('702-6705125-8817807','702-5492481-4068251','701-1848920-5681843')
    ORDER BY so.order_id
  LOOP
    RAISE NOTICE '   % % % q%', rpad(r.mk,3), r.order_id, r.asin, r.qty;
    RAISE NOTICE '        native  % -> %', r.old_est, r.new_est;
    RAISE NOTICE '        LIVE SALES  US$% -> US$%   (change US$%)',
      r.usd_before, r.usd_after, round((r.usd_after - r.usd_before)::numeric,2);
    RAISE NOTICE '        src % | conf % | lock %', r.src, r.conf, r.lf;
    v_before := v_before + r.usd_before;
    v_after  := v_after  + r.usd_after;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   TOTAL across the three: US$% -> US$%  (change US$%)',
    round(v_before,2), round(v_after,2), round(v_after - v_before,2);

  RAISE NOTICE '';
  RAISE NOTICE '== the audit trail recorded it (step 2 proving itself) ==';
  FOR r IN
    SELECT order_id, old_estimate, new_estimate,
           COALESCE(old_price_source,'-') AS osrc, COALESCE(new_price_source,'-') AS nsrc,
           db_role, left(COALESCE(statement,''), 60) AS stmt
    FROM public.sales_order_price_audit
    WHERE order_id IN ('702-6705125-8817807','702-5492481-4068251','701-1848920-5681843')
    ORDER BY id
  LOOP
    RAISE NOTICE '   % | % -> % | % -> % | role %',
      r.order_id, r.old_estimate, r.new_estimate, r.osrc, r.nsrc, r.db_role;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (NO AUDIT ROWS -- the audit trigger is not working)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== P&L UNCHANGED? ==';
  SELECT count(*) INTO n FROM public.financial_events_cache
  WHERE amazon_order_id IN ('702-6705125-8817807','702-5492481-4068251','701-1848920-5681843');
  RAISE NOTICE '   financial_events_cache rows for these 3 orders: % (0 = P&L cannot see them)', n;
  RAISE NOTICE '   The P&L reads ONLY financial_events_cache, and nothing above';
  RAISE NOTICE '   touched that table, so the P&L is unchanged by construction.';

  RAISE NOTICE '';
  RAISE NOTICE '== the other five are untouched, as instructed ==';
  FOR r IN
    SELECT so.order_id, so.marketplace AS mk, so.estimated_price AS est,
           COALESCE(so.locked_from,'-') AS lf
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.order_id IN (SELECT DISTINCT order_id FROM public.keepa_estimate_recheck_log WHERE user_id = v_uid)
      AND so.order_id NOT IN ('702-6705125-8817807','702-5492481-4068251','701-1848920-5681843')
    ORDER BY so.marketplace, so.order_id
  LOOP
    RAISE NOTICE '   % % | est % | lock %', rpad(r.mk,3), r.order_id, r.est, r.lf;
  END LOOP;
END
$p$;
