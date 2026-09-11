-- Annotate the new override, and account for a COGS figure that moved.
--
-- The verification in 20260911060000 reported COGS 18,180.36 against the
-- 18,143.49 measured at 12:53 UTC -- up 36.87 -- and a minimum unit cost of
-- 7.75 where there was none before. An override cannot do that: it only
-- changes how UNLOCKED rows RESOLVE, and it never rewrites the stored
-- total_cost column. 1,230 of 1,231 rows are locked.
--
-- Nine hours passed between the two readings, so new sales are the obvious
-- explanation -- but "obvious" is not "checked". If instead an existing
-- historical row was rewritten, that is the one outcome the seller explicitly
-- ruled out, and it would need undoing.
--
-- The only write here is a note on the override row created minutes ago.

DO $annotate$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  UPDATE public.asin_cost_overrides
     SET note = 'Forward cost from last recorded purchase (7.75, lots dated 2026-05-24/25). '
              || 'History deliberately untouched: 271 units on hand have no purchase record, '
              || 'so the true cost of current stock is unknown. Revisit before 2027 -- the '
              || 'resolver only applies same-calendar-year overrides.'
   WHERE user_id = v_uid AND asin = 'B0G4B3117X' AND effective_from = CURRENT_DATE
     AND note IS NULL;
  RAISE NOTICE 'override annotated';
END
$annotate$;

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. rows touched since 12:53 UTC: new, or edited? ========';
  FOR r IN
    SELECT count(*) AS touched,
           count(*) FILTER (WHERE created_at > '2026-09-11 12:53:00+00') AS newly_created,
           count(*) FILTER (WHERE created_at <= '2026-09-11 12:53:00+00') AS pre_existing_edited,
           round(sum(COALESCE(total_cost,0)) FILTER (WHERE created_at > '2026-09-11 12:53:00+00')::numeric, 2) AS cogs_from_new
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin AND updated_at > '2026-09-11 12:53:00+00'
  LOOP
    RAISE NOTICE '   % rows touched: % newly created, % pre-existing edited',
      r.touched, r.newly_created, r.pre_existing_edited;
    RAISE NOTICE '   COGS contributed by the NEW rows: %  (the gap to explain is 36.87)', r.cogs_from_new;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. every row touched since 12:53, in detail ========';
  FOR r IN
    SELECT order_id, order_date, quantity, cost_locked,
           round(COALESCE(unit_cost_at_sale, unit_cost)::numeric,2) AS unit,
           round(COALESCE(total_cost,0)::numeric,2) AS cogs,
           cost_source_at_sale AS src,
           created_at > '2026-09-11 12:53:00+00' AS is_new,
           updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin AND updated_at > '2026-09-11 12:53:00+00'
    ORDER BY updated_at DESC LIMIT 20
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % % qty=% unit=% cogs=% locked=% new=% src=%',
      r.order_date, r.order_id, r.quantity, r.unit, r.cogs, r.cost_locked, r.is_new, r.src;
  END LOOP;
  IF v_n = 0 THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. THE TEST: any PRE-EXISTING row edited since 12:53? ========';
  v_n := 0;
  FOR r IN
    SELECT order_id, order_date, round(COALESCE(total_cost,0)::numeric,2) AS cogs, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND updated_at > '2026-09-11 12:53:00+00'
      AND created_at <= '2026-09-11 12:53:00+00'
    ORDER BY updated_at DESC LIMIT 10
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   EDITED: % % cogs=% at %', r.order_date, r.order_id, r.cogs, r.updated_at;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   none -- no pre-existing sale was rewritten. History intact.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. rows carrying 7.75 ========';
  FOR r IN
    SELECT order_id, order_date, quantity, cost_locked, cost_source_at_sale AS src,
           round(COALESCE(total_cost,0)::numeric,2) AS cogs
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND round(COALESCE(unit_cost_at_sale, unit_cost)::numeric,2) = 7.75
    ORDER BY order_date DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % % qty=% locked=% src=% cogs=%',
      r.order_date, r.order_id, r.quantity, r.cost_locked, r.src, r.cogs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. the one unlocked row ========';
  FOR r IN
    SELECT order_id, order_date, quantity, round(COALESCE(unit_cost,0)::numeric,2) AS unit,
           round(COALESCE(total_cost,0)::numeric,2) AS cogs, order_status
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND NOT COALESCE(cost_locked,false)
      AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
  LOOP
    RAISE NOTICE '   % % qty=% unit=% cogs=% status=%',
      r.order_date, r.order_id, r.quantity, r.unit, r.cogs, r.order_status;
  END LOOP;
END
$probe$;