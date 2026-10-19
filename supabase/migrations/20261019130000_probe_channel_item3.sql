-- READ-ONLY. Item 3: how many NULL-channel rows can be resolved, and from what.
-- Rewritten set-based: the first version used per-row correlated subqueries
-- over 57,513 rows and hit the statement timeout.
--
-- Evidence ranked by strength:
--   A  shipping_label_fee > 0   -> provably MFN (the seller paid a label)
--   B  fba_fee > 0              -> provably AFN (Amazon charged to ship it)
--   C  a sibling row on the SAME order id already has a known channel
--   D  the SKU has only ever shipped ONE way across known rows
--   E  unknown
--
-- A and B are facts about money Amazon charged. C and D are inference, and D
-- is only safe where the SKU has never shipped both ways.
DO $p$
DECLARE v_uid uuid; r record; v_total bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO v_total FROM public.sales_orders
  WHERE user_id = v_uid AND fulfillment_channel IS NULL AND order_id NOT LIKE '%-REFUND%';
  RAISE NOTICE '== NULL-channel rows to resolve: % ==', v_total;

  CREATE TEMP TABLE _known_by_order AS
  SELECT order_id, max(upper(fulfillment_channel)) AS ch
  FROM public.sales_orders
  WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
  GROUP BY order_id;

  CREATE TEMP TABLE _known_by_sku AS
  SELECT COALESCE(seller_sku, sku) AS k,
         count(DISTINCT upper(fulfillment_channel)) AS n_ch,
         max(upper(fulfillment_channel)) AS ch
  FROM public.sales_orders
  WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
    AND COALESCE(seller_sku, sku) IS NOT NULL
  GROUP BY 1;

  CREATE INDEX ON _known_by_order (order_id);
  CREATE INDEX ON _known_by_sku (k);
  ANALYZE _known_by_order;
  ANALYZE _known_by_sku;

  RAISE NOTICE '';
  RAISE NOTICE '== resolution by strongest available evidence ==';
  FOR r IN
    SELECT CASE
             WHEN COALESCE(n.shipping_label_fee,0) > 0 THEN 'A provably MFN (label fee paid)'
             WHEN COALESCE(n.fba_fee,0) > 0            THEN 'B provably AFN (FBA fee charged)'
             WHEN ko.ch IS NOT NULL                    THEN 'C sibling on same order: ' || ko.ch
             WHEN ks.n_ch = 1                          THEN 'D SKU only ever: ' || ks.ch
             ELSE 'E unknown'
           END AS verdict,
           count(*) AS rows
    FROM public.sales_orders n
    LEFT JOIN _known_by_order ko ON ko.order_id = n.order_id
    LEFT JOIN _known_by_sku   ks ON ks.k = COALESCE(n.seller_sku, n.sku)
    WHERE n.user_id = v_uid AND n.fulfillment_channel IS NULL
      AND n.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows (% pct)', rpad(r.verdict,36), lpad(r.rows::text,6),
      lpad(round((100.0*r.rows/NULLIF(v_total,0))::numeric,1)::text,5);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== age of the NULL rows (Orders API retains ~2 years) ==';
  FOR r IN
    SELECT CASE
             WHEN order_date >= CURRENT_DATE - 30  THEN '1 0-30 days'
             WHEN order_date >= CURRENT_DATE - 90  THEN '2 31-90 days'
             WHEN order_date >= CURRENT_DATE - 365 THEN '3 91-365 days'
             ELSE '4 over 365 days' END AS age_band,
           count(*) AS rows
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NULL AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows', rpad(r.age_band,16), lpad(r.rows::text,6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== sanity: is rule B trustworthy? do KNOWN rows agree? ==';
  FOR r IN
    SELECT upper(fulfillment_channel) AS fc, count(*) AS rows,
           count(*) FILTER (WHERE COALESCE(fba_fee,0) > 0) AS has_fba_fee,
           round((100.0*count(*) FILTER (WHERE COALESCE(fba_fee,0) > 0)/NULLIF(count(*),0))::numeric,1) AS pct_fba,
           count(*) FILTER (WHERE COALESCE(shipping_label_fee,0) > 0) AS has_label
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
      AND order_id NOT LIKE '%-REFUND%' AND COALESCE(is_cancelled,false) = false
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | % carry an fba_fee (% pct) | % carry a label fee',
      rpad(r.fc,4), lpad(r.rows::text,6), lpad(r.has_fba_fee::text,6), r.pct_fba, r.has_label;
  END LOOP;

  DROP TABLE _known_by_order;
  DROP TABLE _known_by_sku;
END
$p$;
