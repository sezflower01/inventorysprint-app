-- PROBE (read-only): "is it fixed?"
--
-- Two open items could be meant, so check both rather than guess:
--   A. B0G4B3117X COGS -- nothing was applied; the repair is waiting on the
--      seller's answers. But the seller may have entered the ~305 missing units
--      or removed the May 2 override since, so compare against the baseline:
--        purchases 1,254 units | override 14.5625 eff 2026-05-02
--        clean sales 1,245 units, COGS 18,128.93, none at 7.75
--   B. repair-collapsed-orders-15min -- scheduled to unschedule itself once the
--      shortlist reaches zero. Baseline 348 candidates.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_found boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== A. B0G4B3117X -- has anything moved? ========';
  FOR r IN
    SELECT sum(units) AS units, round(sum(cost)::numeric,2) AS spend,
           sum(units) FILTER (WHERE cost/NULLIF(units,0) < 10) AS cheap_units,
           max(updated_at) AS last_edit, count(*) AS lots
    FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   purchases: % units in % lots, spend %, cheap units %, last edit %',
      r.units, r.lots, r.spend, r.cheap_units, r.last_edit;
    RAISE NOTICE '   (baseline 1,254 units, 300 cheap)';
  END LOOP;

  v_found := false;
  FOR r IN SELECT unit_cost, effective_from FROM public.asin_cost_overrides
           WHERE user_id = v_uid AND asin = v_asin
  LOOP
    v_found := true;
    RAISE NOTICE '   override: % effective %  (baseline 14.5625 eff 2026-05-02)',
      r.unit_cost, r.effective_from;
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE '   override: REMOVED'; END IF;

  FOR r IN
    SELECT sum(COALESCE(quantity,1)) AS units,
           round(sum(COALESCE(quantity,1) * COALESCE(unit_cost_at_sale, unit_cost, 0))::numeric,2) AS cogs,
           count(*) FILTER (WHERE COALESCE(unit_cost_at_sale, unit_cost) < 10) AS cheap_orders,
           max(updated_at) AS last_touch
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
      AND (is_cancelled IS NULL OR is_cancelled = false)
  LOOP
    RAISE NOTICE '   sales: % units, COGS %, orders under 10.00: %, last touched %',
      r.units, r.cogs, r.cheap_orders, r.last_touch;
    RAISE NOTICE '   (baseline 1,245 units, COGS 18,128.93, 0 cheap orders)';
  END LOOP;

  FOR r IN
    SELECT COALESCE(available,0) + COALESCE(reserved,0) AS on_hand
    FROM public.inventory WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   on hand: %', r.on_hand;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== B. collapsed-order repair cron ========';
  v_found := false;
  FOR r IN SELECT jobname, schedule, active FROM cron.job
           WHERE jobname = 'repair-collapsed-orders-15min'
  LOOP
    v_found := true;
    RAISE NOTICE '   still scheduled: % % active=%', r.jobname, r.schedule, r.active;
  END LOOP;
  IF NOT v_found THEN
    RAISE NOTICE '   cron is GONE -- it unscheduled itself, shortlist reached zero';
  END IF;

  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP
    RAISE NOTICE '   shortlist now: %  (was 348)', r.n;
  END LOOP;

  FOR r IN
    SELECT d.status, count(*) AS runs, max(d.start_time) AS latest
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname = 'repair-collapsed-orders-15min'
    GROUP BY 1
  LOOP
    RAISE NOTICE '   runs: status=% count=% latest=%', r.status, r.runs, r.latest;
  END LOOP;

  FOR r IN
    SELECT count(*) AS n, round(sum(total_cost)::numeric,2) AS cogs
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity > 1
      AND updated_at > '2026-09-10 00:30:00+00'
      AND updated_at < now() - interval '1 minute'
  LOOP
    RAISE NOTICE '   multi-unit rows updated since the sweep started: % (COGS %)', r.n, r.cogs;
  END LOOP;
END
$probe$;
