-- Finish the repair of 114-1602840-1879415: make its fees internally consistent.
--
-- After the price fix the row read: referral $14.63, fba $0, label $5.93, but
-- total_fees $9.70 -- components that do not add up to the total. The fee cache
-- settles which side is wrong:
--
--   asin_fee_cache (US, B08229T8SS, fees_api, verified 2026-10-04 01:44)
--     referral 15.03%   fba_fee_fixed $4.09
--
-- The order is MFN, so Amazon fulfils nothing and there is no FBA fee. Referral
-- on the $97.50 line is 15.03% = $14.65. Adding the $5.93 shipping label the
-- seller actually bought gives $20.58 -- which is what total_fees held before
-- anything touched this row ($20.56, the same figure at a flat 15%).
--
-- So $9.70 is the outlier. It is 9.95% of the line, a rate that appears nowhere
-- in the cache, and it was written by fees_source = 'fees_api_fbm'. That looks
-- like a separate bug in the FBM fee path and is left recorded here rather than
-- chased in this migration: if total_fees returns to $9.70 after the next
-- enrichment pass, the FBM path is recomputing it wrongly and needs its own fix.
--
-- A note on the convention, since it is easy to get backwards: for FBM rows the
-- shipping label IS part of total_fees -- that is how the row was built before
-- ($14.63 + $5.93 = $20.56) and shipping_label_fee keeps its own copy for
-- reporting the label separately.

UPDATE public.sales_orders
SET referral_fee = 14.65,
    fba_fee      = 0,
    total_fees   = 20.58,
    updated_at   = now()
WHERE order_id = '114-1602840-1879415'
  AND quantity = 5
  AND abs(COALESCE(total_sale_amount, 0) - 97.50) < 0.01;   -- only the repaired row

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT order_id, quantity, sold_price, total_sale_amount, referral_fee,
                  fba_fee, shipping_label_fee, total_fees, unit_cost_at_sale,
                  fulfillment_channel, fees_source
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_id = '114-1602840-1879415' LOOP
    RAISE NOTICE '% | qty % | $%/unit, line total $%', r.order_id, r.quantity, r.sold_price, r.total_sale_amount;
    RAISE NOTICE '  referral $% + fba $% + label $% = $% | total_fees $% | % | %',
      r.referral_fee, r.fba_fee, r.shipping_label_fee,
      round((COALESCE(r.referral_fee,0) + COALESCE(r.fba_fee,0) + COALESCE(r.shipping_label_fee,0))::numeric, 2),
      r.total_fees, r.fulfillment_channel, r.fees_source;
    RAISE NOTICE '  profit on the line: $% (cost $%/unit)',
      round((COALESCE(r.total_sale_amount,0) - COALESCE(r.total_fees,0)
             - COALESCE(r.unit_cost_at_sale,0) * r.quantity)::numeric, 2),
      r.unit_cost_at_sale;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT count(*) AS orders, sum(quantity) AS units,
                  round(sum(COALESCE(total_sale_amount, sold_price * quantity))::numeric, 2) AS revenue
           FROM public.sales_orders
           WHERE user_id = v_uid
             AND order_id IN ('114-1602840-1879415', '113-8522899-4553061') LOOP
    RAISE NOTICE 'the two orders: % orders, % units, revenue $% (Amazon: $117.00)',
      r.orders, r.units, r.revenue;
  END LOOP;
END
$p$;
