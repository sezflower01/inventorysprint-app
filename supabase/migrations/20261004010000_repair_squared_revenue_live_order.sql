-- Repair order 114-1602840-1879415, whose squared revenue is why Mobile Live
-- Sales reports $507.00 for two orders worth $117.00.
--
-- Seller Central, pasted by the seller, is the authority here:
--   5 units @ $19.50  ->  item subtotal $97.50  (+$6.10 tax, $103.60 total)
--   shipping label $5.93, carrier USPS, FBM
--
-- Stored instead: sold_price $97.50 (the LINE total in a per-unit field) and
-- total_sale_amount $487.50 (that line total multiplied by quantity again).
--
-- The fees are also mis-split, though their TOTAL is right. referral_fee is 0
-- and fba_fee holds $14.63 -- which is exactly 15% of $97.50, i.e. the referral
-- fee wearing the FBA field's name, on an order Amazon did not fulfil. An FBM
-- order has no FBA fee at all. total_fees $20.56 = $14.63 + the $5.93 label, so
-- the money is right and only the labels are wrong; fixing the split keeps the
-- fee-by-channel reporting honest without changing any total.
--
-- Scope: this one order. The 366-order sweep is a separate, reviewable step.

UPDATE public.sales_orders
SET sold_price        = 19.50,
    item_price        = 19.50,
    total_sale_amount = 97.50,
    referral_fee      = 14.63,
    fba_fee           = 0,
    updated_at        = now()
WHERE order_id = '114-1602840-1879415'
  AND quantity = 5
  -- guarded so a re-run cannot double-apply or touch a corrected row
  AND abs(COALESCE(sold_price, 0) - 97.50) < 0.01;

DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the two orders now ==';
  FOR r IN SELECT order_id, quantity, sold_price, total_sale_amount,
                  referral_fee, fba_fee, shipping_label_fee, total_fees
           FROM public.sales_orders
           WHERE user_id = v_uid
             AND order_id IN ('114-1602840-1879415', '113-8522899-4553061')
           ORDER BY quantity DESC LOOP
    RAISE NOTICE '  % | qty % | $%/unit | total $% | referral $% fba $% label $% | fees $%',
      r.order_id, r.quantity, r.sold_price, r.total_sale_amount,
      r.referral_fee, r.fba_fee, r.shipping_label_fee, r.total_fees;
  END LOOP;

  FOR r IN SELECT round(sum(COALESCE(total_sale_amount, sold_price * quantity))::numeric, 2) AS revenue,
                  sum(quantity) AS units, count(*) AS orders
           FROM public.sales_orders
           WHERE user_id = v_uid
             AND order_id IN ('114-1602840-1879415', '113-8522899-4553061') LOOP
    RAISE NOTICE '';
    RAISE NOTICE '  combined: % orders, % units, revenue $% (Amazon says $117.00)',
      r.orders, r.units, r.revenue;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the whole day, which is what Mobile Live Sales totals ==';
  FOR r IN SELECT count(*) AS orders, sum(quantity) AS units,
                  round(sum(COALESCE(total_sale_amount, sold_price * quantity))::numeric, 2) AS revenue
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_date = '2026-10-03'
             AND COALESCE(is_cancelled, false) = false
             AND order_id NOT LIKE '%-REFUND' LOOP
    RAISE NOTICE '  2026-10-03: % orders, % units, revenue $%', r.orders, r.units, r.revenue;
  END LOOP;
END
$p$;
