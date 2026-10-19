-- READ-ONLY. "Today's sales shows a credit adjustment of 532.25 -- why is it
-- not in the payout, which reads 121.13?"
--
-- The payout figure is computed as revenue - fees - refunds
-- (MobileLiveSales.tsx:2980). Credits/adjustments are fetched separately by
-- fetchAdjustmentTotalsForRange and displayed on their own, so by construction
-- they are NOT part of payout. Break the 532.25 down to show exactly what it
-- is, and whether it SHOULD be in payout.
DO $p$
DECLARE v_uid uuid; r record; v_tot numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1. TODAY (%) credit columns in financial_events_cache ==', CURRENT_DATE;
  RAISE NOTICE '   these are the CREDIT_COLS the app sums into "adjustments"';
  FOR r IN
    SELECT 'reimbursements' AS col, round(sum(COALESCE(reimbursements,0))::numeric,2) AS amt
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
    UNION ALL SELECT 'liquidations', round(sum(COALESCE(liquidations,0))::numeric,2)
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
    UNION ALL SELECT 'warehouse_lost', round(sum(COALESCE(warehouse_lost,0))::numeric,2)
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
    UNION ALL SELECT 'warehouse_damage', round(sum(COALESCE(warehouse_damage,0))::numeric,2)
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
    UNION ALL SELECT 'reversal_reimbursement', round(sum(COALESCE(reversal_reimbursement,0))::numeric,2)
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
    UNION ALL SELECT 'free_replacement_refund_items', round(sum(COALESCE(free_replacement_refund_items,0))::numeric,2)
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
    UNION ALL SELECT 'other_income', round(sum(COALESCE(other_income,0))::numeric,2)
      FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE
  LOOP
    IF COALESCE(r.amt,0) <> 0 THEN
      RAISE NOTICE '   % = %', rpad(r.col,32), r.amt;
      v_tot := v_tot + r.amt;
    END IF;
  END LOOP;
  RAISE NOTICE '   ------------------------------------';
  RAISE NOTICE '   CREDIT TOTAL = % (you are seeing 532.25)', round(v_tot,2);

  RAISE NOTICE '';
  RAISE NOTICE '== 2. which EVENTS make it up? ==';
  FOR r IN
    SELECT COALESCE(amazon_order_id,'(no order)') AS oid,
           COALESCE(marketplace,'-') AS mk,
           round(COALESCE(reimbursements,0)::numeric,2) AS reimb,
           round(COALESCE(reversal_reimbursement,0)::numeric,2) AS rev_reimb,
           round(COALESCE(warehouse_lost,0)::numeric,2) AS wh_lost,
           round(COALESCE(warehouse_damage,0)::numeric,2) AS wh_dmg,
           round(COALESCE(other_income,0)::numeric,2) AS other_inc,
           round(COALESCE(liquidations,0)::numeric,2) AS liq
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = CURRENT_DATE
      AND (COALESCE(reimbursements,0) <> 0 OR COALESCE(reversal_reimbursement,0) <> 0
        OR COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0
        OR COALESCE(other_income,0) <> 0 OR COALESCE(liquidations,0) <> 0)
    ORDER BY (COALESCE(reimbursements,0) + COALESCE(reversal_reimbursement,0)
            + COALESCE(warehouse_lost,0) + COALESCE(warehouse_damage,0)
            + COALESCE(other_income,0) + COALESCE(liquidations,0)) DESC
    LIMIT 25
  LOOP
    RAISE NOTICE '   % % | reimb % | rev_reimb % | lost % | dmg % | other % | liq %',
      rpad(r.oid,22), rpad(r.mk,3), lpad(r.reimb::text,8), lpad(r.rev_reimb::text,8),
      lpad(r.wh_lost::text,8), lpad(r.wh_dmg::text,7), lpad(r.other_inc::text,8), r.liq;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no credit events dated today)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. what the payout figure is built from ==';
  RAISE NOTICE '   MobileLiveSales.tsx:2980  payout = revenue - fees - refunds';
  RAISE NOTICE '   Credits are fetched by a SEPARATE query and shown on their';
  RAISE NOTICE '   own line, so they cannot reach payout. Nothing is lost -- it';
  RAISE NOTICE '   is a definition, not a dropped number.';
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS orders,
           round(sum(CASE
             WHEN COALESCE(total_sale_amount,0) > 0 THEN total_sale_amount
             WHEN COALESCE(sold_price,0) > 0 THEN sold_price * quantity
             ELSE 0 END)::numeric,2) AS settled_revenue,
           round(sum(COALESCE(total_fees,0))::numeric,2) AS fees
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date = CURRENT_DATE
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   today: % orders | settled revenue % | fees %',
      r.orders, r.settled_revenue, r.fees;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. refunds dated today (the third term in payout) ==';
  FOR r IN
    SELECT count(*) AS rows, round(sum(COALESCE(refunds,0))::numeric,2) AS refunds
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = CURRENT_DATE AND COALESCE(refunds,0) <> 0
  LOOP
    RAISE NOTICE '   % rows | refunds %', r.rows, r.refunds;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. DOES THE P&L COUNT THESE CREDITS? ==';
  RAISE NOTICE '   The P&L reads financial_events_cache, which is where these';
  RAISE NOTICE '   credits live -- so they DO reach the P&L even though they do';
  RAISE NOTICE '   not reach the Live Sales payout tile. That difference is the';
  RAISE NOTICE '   likely source of the confusion.';
END
$p$;
