-- AFTER: did the merge fix restore the full order, and how wide is the damage?
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== refresh_pending response ========';
  FOR r IN
    SELECT status_code, left(content::text, 300) AS body FROM net._http_response WHERE id = 58124
  LOOP
    RAISE NOTICE '   % | %', r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 111-8310672-6833058 now ========';
  FOR r IN
    SELECT quantity, sold_price, item_price, total_sale_amount,
           referral_fee, fba_fee, total_fees, unit_cost, total_cost, roi,
           order_status, price_source, fees_source, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '111-8310672-6833058'
  LOOP
    RAISE NOTICE '   quantity=%  sold_price=%  total_sale=%',
      r.quantity, r.sold_price, r.total_sale_amount;
    RAISE NOTICE '   referral=%  fba=%  TOTAL FEES=%', r.referral_fee, r.fba_fee, r.total_fees;
    RAISE NOTICE '   unit_cost=%  total_cost=%  roi=%', r.unit_cost, r.total_cost, r.roi;
    RAISE NOTICE '   status=%  price_source=%  fees_source=%',
      r.order_status, r.price_source, r.fees_source;
    RAISE NOTICE '   updated=%', r.updated_at;
    RAISE NOTICE '';
    RAISE NOTICE '   TARGET: quantity 3, revenue 23.67';
    IF r.quantity = 3 THEN
      RAISE NOTICE '   -> FIXED';
    ELSE
      RAISE NOTICE '   -> still %, refresh may not have reached this order', r.quantity;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many rows show fees exceeding their own revenue? ========';
  -- The visible symptom. Not proof of a collapse on its own -- a genuinely
  -- unprofitable sale looks the same, and this account has known zero-revenue
  -- rows from the price-resolver fallback -- so this is an upper bound.
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE order_date > now() - interval '90 days') AS d90,
           count(*) FILTER (WHERE quantity = 1) AS qty_one,
           round(sum(total_fees - total_sale_amount)::numeric, 2) AS overstated
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(total_sale_amount,0) > 0
      AND COALESCE(total_fees,0) > total_sale_amount
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   % rows where fees > revenue (% in last 90d, % of them qty=1)',
      r.n, r.d90, r.qty_one;
    RAISE NOTICE '   apparent loss carried by those rows: %', r.overstated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== tighter signal: qty=1 but FBA fee looks like a multiple ========';
  -- For a given ASIN the per-unit FBA fee is near-constant. A qty=1 row whose
  -- fba_fee is close to an integer multiple of that ASIN typical per-unit fee
  -- is a collapse candidate rather than an expensive sale.
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT count(*) AS suspects,
           count(*) FILTER (WHERE s.order_date > now() - interval '90 days') AS d90
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1
      AND p.unit_fee > 0
      AND s.fba_fee / p.unit_fee > 1.6
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   % qty=1 rows carry an FBA fee over 1.6x the ASIN per-unit rate',
      r.suspects;
    RAISE NOTICE '   % of them in the last 90 days', r.d90;
    RAISE NOTICE '   (these are the likely collapses -- fees for N units, revenue for 1)';
  END LOOP;
END
$probe$;
