-- Read batch 2 and measure the real repair count.
--
-- The shortlist size is a poor proxy (self-referential medians), so count rows
-- that actually changed instead.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== batch 61408 ========';
  FOR r IN
    SELECT status_code, left(content::text, 260) AS body FROM net._http_response WHERE id = 61408
  LOOP
    RAISE NOTICE '   % | %', r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist ========';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP RAISE NOTICE '   % remain (was 436 at the start, 354 after batch 1)', r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== rows actually corrected today ========';
  FOR r IN
    SELECT count(*) AS rows_fixed,
           sum(quantity) AS units,
           round(sum(total_cost)::numeric,2) AS cogs
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity > 1
      AND updated_at > '2026-09-09 23:30:00+00'
  LOOP
    RAISE NOTICE '   % rows now hold % units and % COGS', r.rows_fixed, r.units, r.cogs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== account-wide qty>1 count ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE quantity > 1) AS multi,
           count(*) FILTER (WHERE quantity = 1) AS single
    FROM public.sales_orders WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % rows with quantity > 1 | % with quantity = 1', r.multi, r.single;
  END LOOP;
END
$probe$;
