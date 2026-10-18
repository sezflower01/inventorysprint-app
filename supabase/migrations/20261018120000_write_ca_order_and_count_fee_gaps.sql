-- (1) Write the verified Seller Central price for CA order 701-0974352-2997055,
--     which currently contributes $0.00 to Live Sales because it has no
--     estimated_price, no sold_price and no total_sale_amount.
-- (2) Count every non-US order whose ASIN has no fee row in that marketplace.
--
-- Amazon order page: purchased 2026-10-18 09:49 PDT, q1, CA$20.36/unit,
-- ASIN B07KY25WY7, SKU NQN-BBR-MLDM, FBA, status Pending.
--
-- Same labelling as the three written on 2026-10-18: price_source is the
-- stable manual:amazon_verified (matches nothing on the isLowConfidenceHint
-- blocklist, so it counts in Live Sales) and locked_from carries a UNIQUE
-- suffix, which preserve_manual_price_override requires -- it only lets a
-- write through when locked_from CHANGES to a manual label, because a BEFORE
-- UPDATE trigger cannot tell an omitted column from one set to the same value.
--
-- This row has locked_from = NULL, so the trigger's WHEN clause does not even
-- fire for it; the unique label is still used so the row is protected from
-- here on.

CREATE TABLE IF NOT EXISTS public.backup_amazon_verified_prices_20261018 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);

INSERT INTO public.backup_amazon_verified_prices_20261018 (reason, row_data)
SELECT 'pre_write_701-0974352-2997055', to_jsonb(so)
FROM public.sales_orders so
WHERE so.order_id = '701-0974352-2997055';

DO $p$
DECLARE v_uid uuid; r record; v_cad numeric; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;
  SELECT count(*) INTO n FROM public.backup_amazon_verified_prices_20261018
  WHERE reason = 'pre_write_701-0974352-2997055';
  RAISE NOTICE '== BACKUP: % row saved for this order ==', n;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE ==';
  FOR r IN
    SELECT quantity AS qty, sold_price, total_sale_amount, estimated_price,
           COALESCE(price_source,'(none)') AS psrc
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   q% | sold % | total % | estimated % | src %',
      r.qty, r.sold_price, r.total_sale_amount,
      COALESCE(r.estimated_price::text,'NULL'), r.psrc;
    RAISE NOTICE '   LIVE SALES contribution: US$0.00  (no price of any kind)';
  END LOOP;
END
$p$;

UPDATE public.sales_orders
SET estimated_price  = 20.36,
    locked_est_price = 20.36,
    locked_from      = 'manual:amazon_verified@20261018T4',
    price_source     = 'manual:amazon_verified',
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_fee_enrich = true,
    next_enrich_after = NULL,
    updated_at       = now()
WHERE order_id = '701-0974352-2997055' AND COALESCE(sold_price,0) = 0;

DO $p$
DECLARE v_uid uuid; r record; v_cad numeric; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;

  RAISE NOTICE '';
  RAISE NOTICE '== AFTER ==';
  FOR r IN
    SELECT quantity AS qty, estimated_price AS est, COALESCE(price_source,'-') AS psrc,
           COALESCE(price_confidence,'-') AS conf, COALESCE(locked_from,'-') AS lf
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   estimated_price % CAD x % / % = US$%',
      r.est, r.qty, v_cad, round((r.est * r.qty / v_cad)::numeric, 2);
    RAISE NOTICE '   src % | conf % | lock %', r.psrc, r.conf, r.lf;
    RAISE NOTICE '';
    RAISE NOTICE '   LIVE SALES for this row: US$0.00 -> US$%',
      round((r.est * r.qty / v_cad)::numeric, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the audit trail caught it ==';
  FOR r IN
    SELECT old_estimate, new_estimate, COALESCE(old_price_source,'(none)') AS osrc,
           COALESCE(new_price_source,'-') AS nsrc, db_role, changed_at
    FROM public.sales_order_price_audit
    WHERE order_id = '701-0974352-2997055' ORDER BY id
  LOOP
    RAISE NOTICE '   % -> % | % -> % | role % | %',
      COALESCE(r.old_estimate::text,'NULL'), r.new_estimate, r.osrc, r.nsrc, r.db_role, r.changed_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no audit row -- investigate)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== P&L ==';
  SELECT count(*) INTO n FROM public.financial_events_cache
  WHERE amazon_order_id = '701-0974352-2997055';
  RAISE NOTICE '   financial_events_cache rows for this order: % (0 = P&L blind to it)', n;

  -- ─── (2) FEE-ROW GAP ────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== 2. NON-US ORDERS WHOSE ASIN HAS NO FEE ROW IN THAT MARKETPLACE ==';
  RAISE NOTICE '';
  RAISE NOTICE '-- 2a. PENDING non-US orders (unsettled) --';
  FOR r IN
    SELECT so.marketplace AS mk,
           count(*) AS orders,
           count(*) FILTER (WHERE fc.asin IS NULL) AS no_fee_row,
           count(*) FILTER (WHERE fc.asin IS NOT NULL AND COALESCE(fc.fba_fee_fixed,0) = 0) AS row_but_zero,
           count(DISTINCT so.asin) FILTER (WHERE fc.asin IS NULL) AS distinct_asins_missing
    FROM public.sales_orders so
    LEFT JOIN public.asin_fee_cache fc
      ON fc.user_id = so.user_id AND fc.asin = so.asin AND fc.marketplace = so.marketplace
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.sold_price,0) = 0 AND COALESCE(so.is_cancelled,false) = false
      AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % pending | % with NO fee row (% distinct ASINs) | % with a row but fba = 0',
      rpad(r.mk,3), lpad(r.orders::text,3), lpad(r.no_fee_row::text,3),
      r.distinct_asins_missing, r.row_but_zero;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- 2b. RECENT non-US orders, last 90 days, settled or not --';
  FOR r IN
    SELECT so.marketplace AS mk,
           count(*) AS orders,
           count(*) FILTER (WHERE fc.asin IS NULL) AS no_fee_row,
           count(DISTINCT so.asin) FILTER (WHERE fc.asin IS NULL) AS distinct_asins_missing
    FROM public.sales_orders so
    LEFT JOIN public.asin_fee_cache fc
      ON fc.user_id = so.user_id AND fc.asin = so.asin AND fc.marketplace = so.marketplace
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date >= current_date - 90
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | % with NO fee row (% distinct ASINs)',
      rpad(r.mk,3), lpad(r.orders::text,4), lpad(r.no_fee_row::text,4), r.distinct_asins_missing;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- 2c. the distinct ASIN+marketplace pairs needing a fetch --';
  FOR r IN
    SELECT DISTINCT so.asin, so.marketplace AS mk,
           (SELECT count(*) FROM public.sales_orders s2
            WHERE s2.user_id = v_uid AND s2.asin = so.asin AND s2.marketplace = so.marketplace
              AND s2.order_date >= current_date - 90
              AND COALESCE(s2.is_cancelled,false) = false) AS orders_90d
    FROM public.sales_orders so
    LEFT JOIN public.asin_fee_cache fc
      ON fc.user_id = so.user_id AND fc.asin = so.asin AND fc.marketplace = so.marketplace
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date >= current_date - 90 AND fc.asin IS NULL
    ORDER BY so.marketplace, so.asin
  LOOP
    RAISE NOTICE '   % % | % orders in 90d', rpad(r.mk,3), r.asin, r.orders_90d;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;
END
$p$;
