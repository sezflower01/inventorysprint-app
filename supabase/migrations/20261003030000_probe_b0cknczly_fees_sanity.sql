-- READ-ONLY PROBE. The 2026 roll-up for B0CKJNCZLY shows fees at $4,208.66 on
-- $6,640.71 of revenue -- 63% -- which cannot be right for an item averaging
-- $11.51. Referral at 15% is about $1.73 and a small-standard FBA fee about
-- $3.50-4.00, so roughly 48% is the expected ceiling. $7.90 per unit says the
-- recorded fees are inflated.
--
-- This is the same ASIN as the multi-unit fee bug fixed on 2026-09-29, where
-- the enrichment path failed to multiply per-unit fees by quantity and 69
-- orders were re-enriched. A double-multiplication on re-enrichment would look
-- exactly like this, so check fees per unit by source and by month before
-- trusting any profit figure built on them.
--
-- Also: 2026-10 reports an average sold price of -2.85, which is impossible and
-- means some rows are corrupt regardless of the fee question.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== fees per unit, by source ==';
  FOR r IN SELECT COALESCE(fees_source, '(none)') AS src, count(*) AS orders,
                  sum(quantity) AS units,
                  round(avg(sold_price)::numeric, 2) AS avg_price,
                  round((sum(total_fees) / NULLIF(sum(quantity), 0))::numeric, 2) AS fees_per_unit,
                  round((100.0 * sum(total_fees) / NULLIF(sum(COALESCE(total_sale_amount, sold_price * quantity)), 0))::numeric, 1) AS fees_pct_of_rev
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false AND order_date >= '2026-01-01'
           GROUP BY 1 ORDER BY 3 DESC LOOP
    RAISE NOTICE '  % | % orders, % units | avg price % | fees/unit % | % pct of revenue',
      r.src, r.orders, r.units, r.avg_price, r.fees_per_unit, r.fees_pct_of_rev;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== fees per unit by month ==';
  FOR r IN SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon,
                  sum(quantity) AS units,
                  round((sum(total_fees) / NULLIF(sum(quantity), 0))::numeric, 2) AS fees_per_unit,
                  round((sum(COALESCE(total_sale_amount, sold_price * quantity)) / NULLIF(sum(quantity), 0))::numeric, 2) AS rev_per_unit
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false AND order_date >= '2026-01-01'
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % | % units | revenue/unit % | fees/unit %', r.mon, r.units, r.rev_per_unit, r.fees_per_unit;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the impossible rows: negative or zero prices ==';
  FOR r IN SELECT order_id, order_date, quantity, sold_price, item_price,
                  total_sale_amount, total_fees, refund_amount, refund_quantity, fees_source, price_source
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false
             AND COALESCE(sold_price, 0) <= 0
           ORDER BY order_date DESC LIMIT 10 LOOP
    RAISE NOTICE '  % (%) | qty % | sold % | item % | total % | fees % | refund %/% | % / %',
      r.order_id, r.order_date, r.quantity, r.sold_price, r.item_price, r.total_sale_amount,
      r.total_fees, r.refund_amount, r.refund_quantity, r.fees_source, r.price_source;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what does the fee cache estimate for this ASIN? ==';
  FOR r IN SELECT * FROM public.asin_fee_cache
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' LIMIT 4 LOOP
    RAISE NOTICE '  %', to_jsonb(r);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no fee cache row)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== recent orders in detail ==';
  FOR r IN SELECT order_id, order_date, quantity, sold_price, total_sale_amount,
                  referral_fee, fba_fee, total_fees, unit_cost_at_sale,
                  refund_quantity, refund_amount, fees_source
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND COALESCE(is_cancelled, false) = false
           ORDER BY order_date DESC LIMIT 8 LOOP
    RAISE NOTICE '  % % | qty % @ % (total %) | ref % fba % = % | cost % | refund %/% | %',
      r.order_date, r.order_id, r.quantity, r.sold_price, r.total_sale_amount,
      r.referral_fee, r.fba_fee, r.total_fees, r.unit_cost_at_sale,
      r.refund_quantity, r.refund_amount, r.fees_source;
  END LOOP;
END
$p$;
