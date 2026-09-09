-- PROBE (read-only): sales_orders is unique on (user_id, order_id, asin) and has
-- no order-item column at all. So two order ITEMS on one order for the SAME
-- ASIN collide, and only one row can exist.
--
-- Amazon order 111-8310672-6833058:
--   item 169335557996641  qty 2 @ 7.89 = 15.78
--   item 169229418255161  qty 1 @ 7.89 =  7.89
--   3 units, 23.67
--
-- Read what survived, whether the fees belong to all three units, and how many
-- other orders are in the same state. Damage first.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== the surviving row for 111-8310672-6833058 ========';
  FOR r IN
    SELECT order_id, asin, sku, seller_sku, quantity, sold_price, item_price,
           total_sale_amount, referral_fee, fba_fee, closing_fee, total_fees,
           unit_cost, total_cost, roi, order_status, is_multi_item_order,
           fees_source, price_source, order_date, created_at, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '111-8310672-6833058'
  LOOP
    RAISE NOTICE '   asin=%  sku=%  seller_sku=%', r.asin, r.sku, r.seller_sku;
    RAISE NOTICE '   quantity=%  sold_price=%  item_price=%  total_sale=%',
      r.quantity, r.sold_price, r.item_price, r.total_sale_amount;
    RAISE NOTICE '   referral=%  fba=%  closing=%  TOTAL FEES=%',
      r.referral_fee, r.fba_fee, r.closing_fee, r.total_fees;
    RAISE NOTICE '   unit_cost=%  total_cost=%  roi=%', r.unit_cost, r.total_cost, r.roi;
    RAISE NOTICE '   is_multi_item_order=%  fees_source=%  price_source=%',
      r.is_multi_item_order, r.fees_source, r.price_source;
    RAISE NOTICE '   status=%  order_date=%', r.order_status, r.order_date;
    RAISE NOTICE '   created=%  updated=%', r.created_at, r.updated_at;
    RAISE NOTICE '';
    RAISE NOTICE '   Amazon total for the order : 3 units, 23.67';
    RAISE NOTICE '   stored                     : % units, %',
      r.quantity, r.total_sale_amount;
    RAISE NOTICE '   fees as %% of stored revenue: %',
      CASE WHEN COALESCE(r.total_sale_amount,0) > 0
           THEN round(r.total_fees / r.total_sale_amount * 100, 1)::text || '%'
           ELSE 'n/a' END;
    RAISE NOTICE '   fees as %% of TRUE revenue  : %',
      round(COALESCE(r.total_fees,0) / 23.67 * 100, 1)::text || '%';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many orders look collapsed? ========';
  -- A collapse leaves a single row whose fees are wildly out of line with its
  -- own revenue, because the fees were accumulated across items that no longer
  -- exist. Amazon referral is ~15%, FBA fee is per unit; anything over 60% of
  -- revenue on a normal FBA order is a strong signal.
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE order_date > now() - interval '90 days') AS last_90d,
           sum(total_fees) AS fees_total,
           sum(total_sale_amount) AS revenue_total
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(total_sale_amount,0) > 0
      AND COALESCE(total_fees,0) > total_sale_amount * 0.6
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   % rows carry fees above 60%% of their own revenue (% in last 90d)',
      r.n, r.last_90d;
    RAISE NOTICE '   those rows: revenue % against fees %', r.revenue_total, r.fees_total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is_multi_item_order: is it being set? ========';
  FOR r IN
    SELECT COALESCE(is_multi_item_order::text,'(null)') AS flag, count(*) AS n
    FROM public.sales_orders WHERE user_id = v_uid
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   is_multi_item_order=%  : % rows', rpad(r.flag,8), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== orders holding several DIFFERENT asins (these DO store fine) ========';
  FOR r IN
    SELECT count(*) AS multi_asin_orders FROM (
      SELECT order_id FROM public.sales_orders WHERE user_id = v_uid
      GROUP BY order_id HAVING count(DISTINCT asin) > 1
    ) x
  LOOP
    RAISE NOTICE '   % orders span more than one ASIN -- unaffected, the key separates them',
      r.multi_asin_orders;
    RAISE NOTICE '   (only repeat lines of the SAME asin on one order collide)';
  END LOOP;
END
$probe$;
