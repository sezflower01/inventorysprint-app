-- READ-ONLY PROBE. B0CKJNCZLY's REAL 2026 result, from
-- financial_events_cache -- the same settlement data the P&L reads, with
-- Amazon's own sign conventions.
--
-- Why this supersedes the 4.6% I quoted: that figure subtracted the gross
-- refund ($1,837.98) from a profit that had ALREADY had the refunded orders'
-- fees deducted. On a refund Amazon credits the referral and FBA fees back and
-- retains only min($5, 20% x referral) -- see src/lib/sales/refundMath.ts -- so
-- charging the fees once in the sale and again inside the refund double-counts
-- them. The settlement rows carry the credits explicitly, so they settle it.
--
-- FEC signs mirror Amazon's settlement JSON: sales positive; refunds negative
-- (cash out); referral_fees and fba_fees negative on a SALE (cost) and positive
-- on a REFUND (credit back). Summing them signed therefore gives true cash.

DO $p$
DECLARE v_uid uuid; r record; v_cogs numeric; v_units int; v_refunded int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== settlement rows for this ASIN, 2026, by event type ==';
  FOR r IN SELECT COALESCE(event_type, '(none)') AS et, count(*) AS rows,
                  round(sum(COALESCE(sales, 0))::numeric, 2) AS sales,
                  round(sum(COALESCE(refunds, 0))::numeric, 2) AS refunds,
                  round(sum(COALESCE(referral_fees, 0))::numeric, 2) AS referral,
                  round(sum(COALESCE(fba_fees, 0))::numeric, 2) AS fba,
                  round(sum(COALESCE(other_fees, 0))::numeric, 2) AS other_fees
           FROM public.financial_events_cache
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND event_date >= '2026-01-01'
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % | % rows | sales % | refunds % | referral % | fba % | other %',
      r.et, r.rows, r.sales, r.refunds, r.referral, r.fba, r.other_fees;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no settlement rows for this ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the signed total: Amazon cash in and out ==';
  FOR r IN SELECT
             round(sum(COALESCE(sales, 0))::numeric, 2) AS sales,
             round(sum(COALESCE(refunds, 0))::numeric, 2) AS refunds,
             round(sum(COALESCE(referral_fees, 0))::numeric, 2) AS referral,
             round(sum(COALESCE(fba_fees, 0))::numeric, 2) AS fba,
             round(sum(COALESCE(fba_customer_return_fees, 0))::numeric, 2) AS return_fees,
             round(sum(COALESCE(restocking_fee, 0))::numeric, 2) AS restocking,
             round(sum(COALESCE(other_fees, 0))::numeric, 2) AS other_fees,
             round(sum(COALESCE(fbm_shipping_label_fee, 0))::numeric, 2) AS labels,
             round(sum(COALESCE(marketplace_facilitator_tax, 0) + COALESCE(marketplace_facilitator_tax_refunds, 0))::numeric, 2) AS facilitator_tax,
             round(sum(COALESCE(promotional_rebates, 0) + COALESCE(promotional_rebate_refunds, 0))::numeric, 2) AS promos,
             round(sum(COALESCE(reimbursements, 0))::numeric, 2) AS reimbursements,
             round((COALESCE(sum(sales), 0) + COALESCE(sum(refunds), 0) + COALESCE(sum(referral_fees), 0)
                    + COALESCE(sum(fba_fees), 0) + COALESCE(sum(fba_customer_return_fees), 0)
                    + COALESCE(sum(restocking_fee), 0) + COALESCE(sum(other_fees), 0)
                    + COALESCE(sum(fbm_shipping_label_fee), 0)
                    + COALESCE(sum(promotional_rebates), 0) + COALESCE(sum(promotional_rebate_refunds), 0)
                    + COALESCE(sum(reimbursements), 0))::numeric, 2) AS net_cash_ex_cogs
           FROM public.financial_events_cache
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND event_date >= '2026-01-01' LOOP
    RAISE NOTICE '  sales % | refunds % | referral % | fba %', r.sales, r.refunds, r.referral, r.fba;
    RAISE NOTICE '  return fees % | restocking % | other % | labels %', r.return_fees, r.restocking, r.other_fees, r.labels;
    RAISE NOTICE '  facilitator tax % | promos % | reimbursements %', r.facilitator_tax, r.promos, r.reimbursements;
    RAISE NOTICE '  NET CASH before COGS: %', r.net_cash_ex_cogs;
  END LOOP;

  -- COGS on the units Amazon actually kept (sold minus returned)
  SELECT sum(quantity), sum(COALESCE(refund_quantity, 0))
    INTO v_units, v_refunded
  FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
    AND order_date >= '2026-01-01' AND COALESCE(is_cancelled, false) = false
    AND order_id NOT LIKE '%-REFUND';

  SELECT unit_cost INTO v_cogs FROM public.asin_cog_for_repricer
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY';

  RAISE NOTICE '';
  RAISE NOTICE '== COGS, two ways (a returned unit may or may not be resellable) ==';
  RAISE NOTICE '  units sold % | units returned % | COG on record %', v_units, v_refunded, v_cogs;
  RAISE NOTICE '  COGS if every return is RESOLD   : % (on % net units)',
    round((v_cogs * (v_units - v_refunded))::numeric, 2), v_units - v_refunded;
  RAISE NOTICE '  COGS if every return is a WRITE-OFF: % (on all % units)',
    round((v_cogs * v_units)::numeric, 2), v_units;
END
$p$;
