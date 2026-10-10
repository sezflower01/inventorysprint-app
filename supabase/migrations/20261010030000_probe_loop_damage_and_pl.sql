-- READ-ONLY. Two questions after stopping job 194.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== confirm the shape of the loop: who repeated, and what are they? ==';
  FOR r IN
    SELECT l.new_status, count(DISTINCT l.order_id) AS orders,
           sum(c.times) AS total_writes, max(c.times) AS worst
    FROM (SELECT DISTINCT ON (order_id) order_id, new_status
          FROM public.stuck_pending_resolution_log ORDER BY order_id, resolved_at DESC) l
    JOIN (SELECT order_id, count(*) AS times
          FROM public.stuck_pending_resolution_log GROUP BY 1) c ON c.order_id = l.order_id
    GROUP BY 1 ORDER BY total_writes DESC
  LOOP
    RAISE NOTICE '  % | % orders | % writes in total | worst single order % times',
      rpad(r.new_status,10), r.orders, r.total_writes, r.worst;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== did the P&L move because of ME, or because three days passed? ==';
  FOR r IN
    SELECT CASE WHEN created_at >= '2026-10-07 18:00:00+00' THEN 'written since the baseline'
                ELSE 'present at the baseline' END AS era,
           count(*) AS rows, round(sum(sales)::numeric,2) AS sales
    FROM public.financial_events_cache WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % rows | sales $%', rpad(r.era,28), r.rows, r.sales;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  baseline was 120429 rows / $2463045.47; anything above that should be';
  RAISE NOTICE '  new settlements, not a rewrite of old ones.';

  RAISE NOTICE '';
  RAISE NOTICE '== and did the resolver touch financial_events_cache at all? ==';
  FOR r IN
    SELECT count(*) AS fec_rows_for_resolved_orders
    FROM public.financial_events_cache f
    WHERE f.user_id = v_uid
      AND f.updated_at >= '2026-10-07 18:00:00+00'
      AND EXISTS (SELECT 1 FROM public.stuck_pending_resolution_log l
                  WHERE l.order_id = f.amazon_order_id)
  LOOP
    RAISE NOTICE '  % financial-event rows for resolved orders were updated since the baseline',
      r.fec_rows_for_resolved_orders;
  END LOOP;
END
$p$;
