-- READ-ONLY. Confirm the payout arithmetic against the numbers on screen:
-- sales 172.21, payout 121.13, credit adjustment 532.25.
DO $p$
DECLARE v_uid uuid; r record; v_rev numeric; v_fees numeric; v_ref numeric; v_cred numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT round(sum(CASE
           WHEN COALESCE(total_sale_amount,0) > 0 THEN total_sale_amount
           WHEN COALESCE(sold_price,0) > 0 THEN sold_price * quantity
           ELSE 0 END)::numeric,2),
         round(sum(COALESCE(total_fees,0))::numeric,2)
    INTO v_rev, v_fees
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_date = CURRENT_DATE
    AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%';

  SELECT round(COALESCE(sum(COALESCE(refunds,0)),0)::numeric,2) INTO v_ref
  FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date = CURRENT_DATE;

  SELECT round(COALESCE(sum(COALESCE(warehouse_lost,0) + COALESCE(warehouse_damage,0)
         + COALESCE(reimbursements,0) + COALESCE(reversal_reimbursement,0)
         + COALESCE(other_income,0) + COALESCE(liquidations,0)),0)::numeric,2) INTO v_cred
  FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date = CURRENT_DATE;

  RAISE NOTICE '== TODAY, the four numbers ==';
  RAISE NOTICE '   settled revenue        %', v_rev;
  RAISE NOTICE '   fees                   %', v_fees;
  RAISE NOTICE '   refunds                %', v_ref;
  RAISE NOTICE '   credits / adjustments  %  <- shown separately', v_cred;
  RAISE NOTICE '';
  RAISE NOTICE '   payout as coded = revenue - fees - refunds = %',
    round((COALESCE(v_rev,0) - COALESCE(v_fees,0) - COALESCE(v_ref,0))::numeric,2);
  RAISE NOTICE '   you see 121.13';
  RAISE NOTICE '';
  RAISE NOTICE '   payout WITH credits would be %',
    round((COALESCE(v_rev,0) - COALESCE(v_fees,0) - COALESCE(v_ref,0) + COALESCE(v_cred,0))::numeric,2);

  RAISE NOTICE '';
  RAISE NOTICE '== what the 532.25 actually IS ==';
  FOR r IN
    SELECT count(*) AS events,
           round(sum(COALESCE(warehouse_lost,0))::numeric,2) AS lost,
           round(sum(COALESCE(warehouse_damage,0))::numeric,2) AS dmg,
           count(DISTINCT COALESCE(marketplace,'UNK')) AS markets,
           string_agg(DISTINCT COALESCE(marketplace,'UNK'), ',') AS mk_list
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = CURRENT_DATE
      AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0)
  LOOP
    RAISE NOTICE '   % adjustment events | warehouse_lost % | warehouse_damage %',
      r.events, r.lost, r.dmg;
    RAISE NOTICE '   marketplace tag(s): %  <- note these carry no real marketplace', r.mk_list;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   warehouse_lost is Amazon REIMBURSING you for inventory it';
  RAISE NOTICE '   lost; warehouse_damage likewise for inventory it damaged.';
  RAISE NOTICE '   That is real money Amazon pays, not a sale -- which is why';
  RAISE NOTICE '   it is not in "sales", but it IS in a disbursement.';

  RAISE NOTICE '';
  RAISE NOTICE '== is this normal, or a one-off spike? last 14 days ==';
  FOR r IN
    SELECT event_date, count(*) AS events,
           round(sum(COALESCE(warehouse_lost,0) + COALESCE(warehouse_damage,0))::numeric,2) AS credits
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= CURRENT_DATE - 14
      AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0)
    GROUP BY 1 ORDER BY 1 DESC
  LOOP
    RAISE NOTICE '   % | % events | %', r.event_date, lpad(r.events::text,4), r.credits;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none in 14 days besides today)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== does the P&L already count them? ==';
  RAISE NOTICE '   The P&L reads financial_events_cache, which is exactly where';
  RAISE NOTICE '   these rows live, so the P&L DOES see them. Only the Live';
  RAISE NOTICE '   Sales payout tile leaves them out.';
END
$p$;
