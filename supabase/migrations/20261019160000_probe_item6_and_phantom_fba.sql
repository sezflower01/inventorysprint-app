-- READ-ONLY. Item 6: is MFN = 124 plausible? Plus a finding from the item-3
-- backfill that needs its own look.
--
-- PHANTOM FBA FEE. Of the 32 rows just set to MFN by rule A, most carry BOTH a
-- seller-paid label fee AND an fba_fee. An order cannot sensibly have both:
-- either Amazon shipped it (FBA fee, no seller label) or the seller did (label,
-- no FBA fee). Commit 5d115da (2026-08-07) is titled "Fix phantom FBA fee on
-- orders converted to self-fulfillment", so this pattern is already known.
-- Quantify what it costs.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== PHANTOM FBA FEE on the newly-tagged MFN rows ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE COALESCE(fba_fee,0) > 0) AS with_both,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS phantom_total,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS real_label_total
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_id IN (SELECT row_data->>'order_id'
                       FROM public.backup_channel_backfill_20261019)
  LOOP
    RAISE NOTICE '   % rows | % carry BOTH a label fee and an fba_fee', r.rows, r.with_both;
    RAISE NOTICE '   fba_fee total %  <- likely phantom, overstating cost', r.phantom_total;
    RAISE NOTICE '   label fee total % <- the real seller-paid cost', r.real_label_total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the same pattern across ALL orders, not just these 32 ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS rows,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba_total,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS label_total
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows with BOTH | fba % | label %',
      rpad(r.fc,8), lpad(r.rows::text,5), lpad(r.fba_total::text,9), r.label_total;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no rows carry both)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 6: is 124 MFN orders plausible? ==';
  RAISE NOTICE '';
  RAISE NOTICE '-- 6a. SKUs the seller has ever shipped themselves (label fee paid) --';
  FOR r IN
    SELECT COALESCE(seller_sku, sku, '(none)') AS k, count(*) AS orders,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS labels,
           min(order_date) AS first_order, max(order_date) AS last_order
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC LIMIT 20
  LOOP
    RAISE NOTICE '   % | % orders | labels % | % .. %',
      rpad(r.k,20), lpad(r.orders::text,4), lpad(r.labels::text,8), r.first_order, r.last_order;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- 6b. how many DISTINCT SKUs have ever carried a label fee? --';
  FOR r IN
    SELECT count(DISTINCT COALESCE(seller_sku, sku)) AS fbm_skus,
           count(*) AS fbm_orders,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS total_labels
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   % SKUs | % orders | % of label cost', r.fbm_skus, r.fbm_orders, r.total_labels;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- 6c. FBM listings in inventory (an FBM listing means self-ship) --';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory'
      AND (column_name ILIKE '%fbm%' OR column_name ILIKE '%fba%'
        OR column_name ILIKE '%channel%' OR column_name ILIKE '%fulfill%')
  LOOP
    RAISE NOTICE '   inventory channel columns: %', COALESCE(r.cols,'(none)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- 6d. verdict framing --';
  RAISE NOTICE '   124 tagged MFN against % orders carrying a real label fee.',
    (SELECT count(*) FROM public.sales_orders WHERE user_id = v_uid
       AND COALESCE(shipping_label_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%');
  RAISE NOTICE '   If those two numbers are close, 124 is plausible and the';
  RAISE NOTICE '   seller simply ships very little themselves. If label fees';
  RAISE NOTICE '   far exceed 124, the AFN defaults have been absorbing FBM.';
END
$p$;
