-- READ-ONLY PROBE. Did the re-enrichment fix the multi-unit fees?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the seller''s example ==';
  FOR r IN SELECT order_id, quantity, sold_price, referral_fee, fba_fee, total_fees, fees_source, roi
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_id IN ('114-0628939-5256223', '111-6724559-6861005') ORDER BY quantity LOOP
    RAISE NOTICE '  % | qty % @ % | referral % fba % TOTAL % | % | roi %',
      r.order_id, r.quantity, r.sold_price, r.referral_fee, r.fba_fee, r.total_fees, r.fees_source, r.roi;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT count(*) AS still_bad, sum(quantity) AS units
           FROM public.sales_orders
           WHERE user_id = v_uid AND quantity > 1 AND COALESCE(is_cancelled,false) = false
             AND COALESCE(total_fees,0) > 0
             AND COALESCE(total_sale_amount, sold_price * quantity, 0) > 0
             AND total_fees < 0.15 * COALESCE(total_sale_amount, sold_price * quantity)
             AND COALESCE(fees_source,'') <> 'financial_events' LOOP
    RAISE NOTICE 'still under-billed (excluding settlements): % orders, % units', r.still_bad, COALESCE(r.units,0);
  END LOOP;

  FOR r IN SELECT count(*) AS pending FROM public.sales_orders
           WHERE user_id = v_uid AND needs_fee_enrich = true AND fees_source IS NULL AND quantity > 1 LOOP
    RAISE NOTICE 'still waiting for enrichment: %', r.pending;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== fees as a share of the sale, by order size (2026) ==';
  FOR r IN SELECT CASE WHEN quantity = 1 THEN 'a 1 unit' WHEN quantity BETWEEN 2 AND 5 THEN 'b 2-5' ELSE 'c 6+' END AS bucket,
                  count(*) AS orders,
                  round(avg(100.0 * COALESCE(total_fees,0) / NULLIF(COALESCE(total_sale_amount, sold_price*quantity),0))::numeric,1) AS fees_pct
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date >= '2026-01-01' AND COALESCE(is_cancelled,false) = false
             AND COALESCE(total_fees,0) > 0 AND COALESCE(total_sale_amount, sold_price*quantity,0) > 0
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : % orders | fees % pct of sale', r.bucket, r.orders, r.fees_pct;
  END LOOP;
END
$p$;
