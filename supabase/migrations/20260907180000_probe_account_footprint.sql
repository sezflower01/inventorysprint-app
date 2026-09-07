-- PROBE (read-only): the complete footprint of bassamshomali499@gmail.com.
--
-- The seller has asked for everything belonging to this account to be removed.
-- That is a hard delete of real business data -- 1,721 sales orders and 3,786
-- inventory rows were already visible -- so the full blast radius has to be on
-- screen before anything is destroyed, not just the tables we happened to be
-- looking at today.
--
-- This walks EVERY table in public that has a user_id column and counts what
-- belongs to that account, so nothing is missed and nothing is a surprise.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_sql text; v_n bigint; v_total bigint := 0; v_tables int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'bassamshomali499@gmail.com';
  IF v_uid IS NULL THEN
    RAISE NOTICE 'no such account';
    RETURN;
  END IF;
  RAISE NOTICE 'account: bassamshomali499@gmail.com  user_id %', v_uid;

  FOR r IN
    SELECT u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at
    FROM auth.users u WHERE u.id = v_uid
  LOOP
    RAISE NOTICE 'signed up % | last sign-in % | confirmed %',
      r.created_at, COALESCE(r.last_sign_in_at::text,'never'), COALESCE(r.email_confirmed_at::text,'no');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== rows owned, by table ========';
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'user_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    v_sql := format('SELECT count(*) FROM public.%I WHERE user_id = $1', r.table_name);
    BEGIN
      EXECUTE v_sql INTO v_n USING v_uid;
    EXCEPTION WHEN OTHERS THEN
      v_n := -1;   -- type mismatch or permission issue; report rather than hide
    END;
    IF v_n > 0 THEN
      v_tables := v_tables + 1;
      v_total := v_total + v_n;
      RAISE NOTICE '   %-44s %', r.table_name, v_n;
    ELSIF v_n < 0 THEN
      RAISE NOTICE '   %-44s (could not count)', r.table_name;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'TOTAL: % rows across % tables', v_total, v_tables;

  RAISE NOTICE '';
  RAISE NOTICE '======== what is genuinely at stake ========';
  FOR r IN
    SELECT
      (SELECT count(*) FROM public.sales_orders WHERE user_id = v_uid) AS orders,
      (SELECT round(sum(COALESCE(item_price,0))::numeric,2) FROM public.sales_orders WHERE user_id = v_uid) AS revenue,
      (SELECT min(order_date) FROM public.sales_orders WHERE user_id = v_uid) AS first_order,
      (SELECT max(order_date) FROM public.sales_orders WHERE user_id = v_uid) AS last_order,
      (SELECT count(*) FROM public.inventory WHERE user_id = v_uid) AS inventory_rows,
      (SELECT count(*) FROM public.created_listings WHERE user_id = v_uid) AS created_listings
  LOOP
    RAISE NOTICE '   % orders, $% revenue, % .. %', r.orders, r.revenue, r.first_order, r.last_order;
    RAISE NOTICE '   % inventory rows, % created listings', r.inventory_rows, r.created_listings;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the orphan rule from the DELETED account ========';
  FOR r IN
    SELECT rr.id, rr.name, rr.is_default
    FROM public.repricer_rules rr
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = rr.user_id)
  LOOP
    RAISE NOTICE '   % | % | default=% | owner no longer exists', left(r.id::text,8), r.name, r.is_default;
  END LOOP;
END
$probe$;
