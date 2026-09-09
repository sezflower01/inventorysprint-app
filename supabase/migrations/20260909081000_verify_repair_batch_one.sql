-- Verify the live repair batch landed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== function response ========';
  FOR r IN SELECT status_code, content::text AS body FROM net._http_response WHERE id = 60611
  LOOP
    RAISE NOTICE 'status %', r.status_code;
    RAISE NOTICE '%', left(r.body, 2200);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the three repaired rows, read back ========';
  FOR r IN
    SELECT order_id, asin, quantity, sold_price, total_sale_amount,
           unit_cost, total_cost, total_fees, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id IN (
      '111-8310672-6833058', '112-4585652-6745824', '111-0457401-1966628')
    ORDER BY order_date DESC
  LOOP
    RAISE NOTICE '   % | %', r.order_id, r.asin;
    RAISE NOTICE '       qty=%  sold_price=%  revenue=%',
      r.quantity, r.sold_price, round(r.total_sale_amount::numeric,2);
    RAISE NOTICE '       unit_cost=%  total_cost=%  fees=%',
      r.unit_cost, r.total_cost, round(r.total_fees::numeric,2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the seller original order ========';
  FOR r IN
    SELECT quantity, total_sale_amount, total_fees, total_cost,
           round((total_fees / NULLIF(total_sale_amount,0) * 100)::numeric,1) AS fee_pct,
           round((total_sale_amount - total_fees - COALESCE(total_cost,0))::numeric,2) AS profit
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '111-8310672-6833058'
  LOOP
    RAISE NOTICE '   quantity %  revenue %  fees %  cogs %',
      r.quantity, round(r.total_sale_amount::numeric,2),
      round(r.total_fees::numeric,2), r.total_cost;
    RAISE NOTICE '   fee rate %%%  |  profit %', r.fee_pct, r.profit;
    RAISE NOTICE '   (was: 1 unit, 7.89 revenue, 159.3%% fee rate, negative profit)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist remaining ========';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 1000)
  LOOP
    RAISE NOTICE '   % rows still on the shortlist', r.n;
    RAISE NOTICE '   (a repaired row leaves it automatically -- quantity is no longer 1)';
  END LOOP;
END
$probe$;
