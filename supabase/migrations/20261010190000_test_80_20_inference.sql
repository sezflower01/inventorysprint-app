-- READ-ONLY. Did the 80/20 split I inferred from a 10-order sample hold?
--
-- The inference was specifically about orders WE had labelled Pending: of ten
-- sampled, Amazon called eight Canceled and two Shipped. The 150 resolved in
-- this restart were a mix of our Pending, Shipped and null labels, so the
-- headline split is not a like-for-like test. This one is.
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== what WE said -> what AMAZON said, across the whole restart ==';
  FOR r IN
    SELECT COALESCE(old_status,'(null)') AS ours,
           CASE WHEN new_is_cancelled THEN 'Canceled' ELSE new_status END AS theirs,
           count(*) AS orders,
           round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (PARTITION BY COALESCE(old_status,'(null)')), 0), 1) AS pct
    FROM (SELECT DISTINCT ON (order_id) order_id, old_status, new_status, new_is_cancelled
          FROM public.stuck_pending_resolution_log
          WHERE resolved_at > '2026-10-10 13:00:00+00'
          ORDER BY order_id, resolved_at DESC) t
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '  we said % -> Amazon said % | % orders | % pct of that label',
      rpad(r.ours,10), rpad(r.theirs,10), lpad(r.orders::text,4), r.pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the inference under test: our "Pending" orders only ==';
  FOR r IN
    SELECT CASE WHEN new_is_cancelled THEN 'Canceled' ELSE new_status END AS theirs,
           count(*) AS orders,
           round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS pct
    FROM (SELECT DISTINCT ON (order_id) order_id, old_status, new_status, new_is_cancelled
          FROM public.stuck_pending_resolution_log
          WHERE resolved_at > '2026-10-10 13:00:00+00'
          ORDER BY order_id, resolved_at DESC) t
    WHERE old_status = 'Pending'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  Amazon said % | % orders | % pct  (I predicted 80 pct Canceled / 20 pct Shipped)',
      rpad(r.theirs,10), lpad(r.orders::text,4), r.pct;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no rows carried old_status = Pending)'; END IF;
END
$p$;
