-- READ-ONLY. B00LFXMBKI: Amazon shows 145 units available, inventory valuation
-- shows zero, the repricer skips it for being zero, row says last sync 09/03.
--
-- Rewritten to dump the row as jsonb instead of naming columns -- the first
-- version guessed `seller_sku`, which does not exist on inventory, and failed.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== inventory columns ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory'
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every inventory row for B00LFXMBKI, verbatim ==';
  FOR r IN
    SELECT jsonb_pretty(to_jsonb(inv)) AS row_json
    FROM public.inventory inv
    WHERE inv.user_id = v_uid AND inv.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '%', r.row_json;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO inventory row at all for B00LFXMBKI'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== has it sold? (proof the stock is real) ==';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           min(order_date) AS first_order, max(order_date) AS last_order
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   % orders | % units | % .. %',
      r.orders, COALESCE(r.units::text,'0'), COALESCE(r.first_order::text,'-'),
      COALESCE(r.last_order::text,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how stale is this row vs the rest of inventory? ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE updated_at > now() - interval '2 days') AS fresh_2d,
           count(*) FILTER (WHERE updated_at < now() - interval '14 days') AS stale_14d,
           count(*) FILTER (WHERE updated_at < now() - interval '30 days') AS stale_30d,
           min(updated_at)::date AS oldest
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % rows | % fresh(2d) | % stale>14d | % stale>30d | oldest %',
      r.rows, r.fresh_2d, r.stale_14d, r.stale_30d, r.oldest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== tables that might hold the refresh queue / assignments ==';
  FOR r IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name ILIKE '%inventory%' OR table_name ILIKE '%assignment%'
        OR table_name ILIKE '%refresh%')
    ORDER BY table_name
  LOOP RAISE NOTICE '   %', r.table_name; END LOOP;
END
$p$;
