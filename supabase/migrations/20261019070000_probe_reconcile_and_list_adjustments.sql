-- READ-ONLY. Reconcile 121.13 / 172.21 / 532.25 / 481.17 and list the 30
-- adjustment events in detail.
--
-- The 481.17 I quoted was WRONG and you spotted why. I computed it as
-- settled_revenue - fees - refunds + credits = 0.00 - 51.08 - 0 + 532.25,
-- using SETTLED revenue (which is 0 today) while the tile's payout uses
-- ESTIMATE-based sales (172.21). Mixing those two bases produces a number
-- that is neither. It is credits minus fees with no sales in it at all.
DO $p$
DECLARE
  v_uid uuid; r record;
  v_settled numeric; v_est numeric; v_fees numeric; v_ref numeric; v_cred numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- Settled vs estimated, split apart.
  SELECT
    round(COALESCE(sum(CASE WHEN COALESCE(total_sale_amount,0) > 0 THEN total_sale_amount
                            WHEN COALESCE(sold_price,0) > 0 THEN sold_price * quantity
                            ELSE 0 END),0)::numeric,2),
    round(COALESCE(sum(CASE WHEN COALESCE(total_sale_amount,0) = 0 AND COALESCE(sold_price,0) = 0
                            THEN COALESCE(estimated_price,0) * quantity / COALESCE(fx.rate,1)
                            ELSE 0 END),0)::numeric,2),
    round(COALESCE(sum(COALESCE(total_fees,0)),0)::numeric,2)
  INTO v_settled, v_est, v_fees
  FROM public.sales_orders so
  LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
    CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
  WHERE so.user_id = v_uid AND so.order_date = CURRENT_DATE
    AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%';

  SELECT round(COALESCE(sum(COALESCE(refunds,0)),0)::numeric,2) INTO v_ref
  FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE;

  SELECT round(COALESCE(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
       +COALESCE(reimbursements,0)+COALESCE(reversal_reimbursement,0)
       +COALESCE(other_income,0)+COALESCE(liquidations,0)),0)::numeric,2) INTO v_cred
  FROM public.financial_events_cache WHERE user_id = v_uid AND event_date = CURRENT_DATE;

  RAISE NOTICE '== RECONCILIATION, today ==';
  RAISE NOTICE '   settled revenue      %   <- orders Amazon has priced', v_settled;
  RAISE NOTICE '   estimated revenue    %   <- pending orders, our estimate', v_est;
  RAISE NOTICE '   SALES (the tile)     %   = settled + estimated',
    round(COALESCE(v_settled,0)+COALESCE(v_est,0),2);
  RAISE NOTICE '   you see 172.21';
  RAISE NOTICE '';
  RAISE NOTICE '   fees                 %', v_fees;
  RAISE NOTICE '   refunds              %', v_ref;
  RAISE NOTICE '   PAYOUT               %   = sales - fees - refunds',
    round(COALESCE(v_settled,0)+COALESCE(v_est,0)-COALESCE(v_fees,0)-COALESCE(v_ref,0),2);
  RAISE NOTICE '   you see 121.13';
  RAISE NOTICE '';
  RAISE NOTICE '   adjustments (credits) %  <- SETTLED cash, from financial events', v_cred;
  RAISE NOTICE '';
  RAISE NOTICE '   CORRECT COMBINED     %   = payout + adjustments',
    round(COALESCE(v_settled,0)+COALESCE(v_est,0)-COALESCE(v_fees,0)-COALESCE(v_ref,0)+COALESCE(v_cred,0),2);
  RAISE NOTICE '';
  RAISE NOTICE '   MY 481.17 WAS WRONG: it was %  -  %  =  %, i.e. credits minus',
    v_cred, v_fees, round(COALESCE(v_cred,0)-COALESCE(v_fees,0),2);
  RAISE NOTICE '   fees with NO sales term, because I used settled revenue (%)',
    v_settled;
  RAISE NOTICE '   while the tile uses estimate-based sales. Two different bases.';

  RAISE NOTICE '';
  RAISE NOTICE '== what columns does financial_events_cache offer for detail? ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache'
      AND (column_name ILIKE '%asin%' OR column_name ILIKE '%sku%'
        OR column_name ILIKE '%quantity%' OR column_name ILIKE '%unit%'
        OR column_name ILIKE '%reason%' OR column_name ILIKE '%type%'
        OR column_name ILIKE '%market%' OR column_name ILIKE '%desc%')
  LOOP
    RAISE NOTICE '   %', r.cols;
  END LOOP;
END
$p$;
