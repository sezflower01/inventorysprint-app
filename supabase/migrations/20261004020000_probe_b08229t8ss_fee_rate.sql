-- READ-ONLY PROBE. I wrote referral_fee = $14.63 on 114-1602840-1879415 by
-- assuming the usual 15% referral, because that is what the $14.63 sitting in
-- the fba_fee field worked out to. But total_fees on the row reads $9.70, which
-- is 9.95% of the $97.50 line -- so either my split is wrong or total_fees is.
--
-- $9.70 and $1.94 (on the single-unit order) are the same rate on different
-- quantities, which points at the fee cache rather than at a mistake: whatever
-- enriched these rows used a referral rate near 9.95%, not 15%.
--
-- Settle it from asin_fee_cache before leaving the row internally inconsistent.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== fee cache for B08229T8SS ==';
  FOR r IN SELECT marketplace, referral_rate, fba_fee_fixed, fee_source,
                  last_verified_at, updated_at
           FROM public.asin_fee_cache
           WHERE user_id = v_uid AND asin = 'B08229T8SS' ORDER BY marketplace LOOP
    RAISE NOTICE '  % | referral % pct | fba fixed $% | % | verified %',
      r.marketplace, round(100 * r.referral_rate, 2), round(r.fba_fee_fixed, 2),
      r.fee_source, r.last_verified_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no fee cache row)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what fees have other orders of this ASIN carried? ==';
  FOR r IN SELECT quantity, count(*) AS orders,
                  round(avg(sold_price)::numeric, 2) AS avg_unit_price,
                  round(avg(referral_fee)::numeric, 2) AS avg_referral,
                  round(avg(fba_fee)::numeric, 2) AS avg_fba,
                  round(avg(total_fees)::numeric, 2) AS avg_total,
                  round(avg(100.0 * total_fees / NULLIF(COALESCE(total_sale_amount, sold_price * quantity), 0))::numeric, 1) AS pct_of_rev,
                  string_agg(DISTINCT COALESCE(fulfillment_channel, '?'), ',') AS channels
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B08229T8SS'
             AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
             AND COALESCE(sold_price, 0) > 0
           GROUP BY quantity ORDER BY quantity LOOP
    RAISE NOTICE '  qty % | % orders | $%/unit | referral $% | fba $% | total $% (% pct) | %',
      r.quantity, r.orders, r.avg_unit_price, r.avg_referral, r.avg_fba,
      r.avg_total, r.pct_of_rev, r.channels;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the repaired row as it stands ==';
  FOR r IN SELECT order_id, quantity, sold_price, total_sale_amount, referral_fee,
                  fba_fee, closing_fee, shipping_label_fee, total_fees, fees_source,
                  fulfillment_channel
           FROM public.sales_orders
           WHERE user_id = v_uid AND order_id = '114-1602840-1879415' LOOP
    RAISE NOTICE '  qty % | $%/unit, total $% | referral $% fba $% closing $% label $% | total_fees $% | % | %',
      r.quantity, r.sold_price, r.total_sale_amount, r.referral_fee, r.fba_fee,
      r.closing_fee, r.shipping_label_fee, r.total_fees, r.fees_source, r.fulfillment_channel;
    RAISE NOTICE '  components add to $% against total_fees $%',
      round((COALESCE(r.referral_fee,0) + COALESCE(r.fba_fee,0) + COALESCE(r.closing_fee,0))::numeric, 2),
      r.total_fees;
  END LOOP;
END
$p$;
