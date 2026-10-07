-- READ-ONLY. The resolver dry run surfaced order ids ending '-REFUND-1'.
-- Every cohort filter in this investigation used `order_id NOT LIKE '%-REFUND'`,
-- which does NOT match '-REFUND-1'. So refund rows have been inside the counts.
-- Size the contamination before trusting any figure that used that filter.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== shapes of refund order ids ==';
  FOR r IN
    SELECT CASE
             WHEN order_id LIKE '%-REFUND' THEN 'ends -REFUND'
             WHEN order_id LIKE '%-REFUND-%' THEN 'ends -REFUND-N'
             ELSE 'not a refund row' END AS shape,
           count(*) AS rows
    FROM public.sales_orders WHERE user_id = v_uid GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '  % | % rows', rpad(r.shape, 20), r.rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many -REFUND-N rows slipped into the cohort figures? ==';
  FOR r IN
    SELECT count(*) AS rows, sum(quantity) AS units,
           round(sum(estimated_price * quantity)::numeric, 2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND'      -- the filter as used
      AND order_id LIKE '%-REFUND-%'        -- but still a refund row
      AND order_date <= current_date - 90
  LOOP
    RAISE NOTICE '  % rows | % units | $% of the cohort total was refund rows',
      r.rows, COALESCE(r.units::text,'0'), COALESCE(r.est::text,'0.00');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the cohort recomputed with a CORRECT refund filter ==';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           round(sum(estimated_price * quantity)::numeric, 2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND%'
      AND order_date <= current_date - 90
  LOOP
    RAISE NOTICE '  % orders | % units | $%  (reported earlier as 284 / $7654.91)',
      r.orders, r.units, r.est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and did the is_cancelled backfill touch any refund rows? ==';
  FOR r IN
    SELECT count(*) AS rows FROM public.backup_cancelled_flag_20261007
    WHERE row_data->>'order_id' LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '  % of the 321 backed-up rows were refund rows (want 0)', r.rows;
  END LOOP;
END
$p$;
