-- PROBE (read-only): B0G4B3117X -- where would FIFO put the 7.75 units, and
-- did today's listing edit log anything to cost_history?
--
-- Why FIFO has to be measured and not assumed. 954 units were bought at
-- 14.56-15.89 (lots dated 2026-02-28 .. 2026-05-21) and 300 at 7.75 (lots dated
-- 2026-05-24 .. 25). 894 units sold on/after 2026-05-24. The resolver's rule --
-- newest cost on or before the order date -- would put 7.75 on all 894, which
-- is three times the cheap stock that exists and would understate COGS by
-- roughly 4,000. The honest total correction is bounded by the 300 cheap units:
-- 300 x (14.5625 - 7.75) = 2,043.75. The method only decides WHICH orders and
-- months absorb it.
--
-- Under FIFO the expensive stock sells first, so the 7.75 units are the LAST
-- 300 sold. This finds that boundary by running total, in the order the sales
-- actually happened.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== units bought, exactly ========';
  FOR r IN
    SELECT round((cost/NULLIF(units,0))::numeric, 4) AS unit,
           sum(units) AS units, round(sum(cost)::numeric, 2) AS spend
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1 ORDER BY 1 DESC
  LOOP
    RAISE NOTICE '   unit % : % units, spend %', r.unit, r.units, r.spend;
  END LOOP;
  FOR r IN
    SELECT sum(units) AS units, round(sum(cost)::numeric, 2) AS spend,
           round((sum(cost) / NULLIF(sum(units),0))::numeric, 4) AS wavg
    FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   TOTAL % units, spend %, weighted average % per unit',
      r.units, r.spend, r.wavg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== units sold (non-cancelled, qty > 0) ========';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           round(sum(total_cost)::numeric, 2) AS cogs_booked
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
      AND COALESCE(quantity,0) > 0
  LOOP
    RAISE NOTICE '   % orders, % units, COGS booked %', r.orders, r.units, r.cogs_booked;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== FIFO: where does the running total cross 954 units? ========';
  FOR r IN
    WITH s AS (
      SELECT order_id, order_date, purchase_timestamp_utc, quantity,
             sum(quantity) OVER (
               ORDER BY order_date, purchase_timestamp_utc NULLS LAST, order_id
               ROWS UNBOUNDED PRECEDING) AS running
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin
        AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
        AND COALESCE(quantity,0) > 0
    )
    SELECT order_id, order_date, quantity, running
    FROM s WHERE running BETWEEN 950 AND 960
    ORDER BY running
  LOOP
    RAISE NOTICE '   % % qty=% running=%', r.order_date, r.order_id, r.quantity, r.running;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== FIFO allocation by month ========';
  -- Units beyond 954 cumulative are the 7.75 stock; beyond 1,254 there is no
  -- purchase record at all.
  FOR r IN
    WITH s AS (
      SELECT order_date, quantity,
             sum(quantity) OVER (
               ORDER BY order_date, purchase_timestamp_utc NULLS LAST, order_id
               ROWS UNBOUNDED PRECEDING) AS running
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin
        AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
        AND COALESCE(quantity,0) > 0
    ),
    split AS (
      SELECT order_date,
             GREATEST(0, LEAST(running, 954) - GREATEST(running - quantity, 0)) AS exp_units,
             GREATEST(0, LEAST(running, 1254) - GREATEST(running - quantity, 954)) AS cheap_units,
             GREATEST(0, running - GREATEST(running - quantity, 1254)) AS unbacked_units
      FROM s
    )
    SELECT to_char(order_date,'YYYY-MM') AS mon,
           sum(exp_units) AS expensive, sum(cheap_units) AS cheap, sum(unbacked_units) AS unbacked
    FROM split GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % units @14.56+ | % units @7.75 | % with no purchase record',
      r.mon, r.expensive, r.cheap, r.unbacked;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== did today''s edit log to cost_history? ========';
  FOR r IN
    SELECT effective_date, recorded_at, round(cost::numeric, 4) AS cost, sku
    FROM public.cost_history
    WHERE user_id = v_uid AND asin = v_asin
      AND (cost < 10 OR recorded_at > now() - interval '3 days')
    ORDER BY recorded_at DESC LIMIT 12
  LOOP
    RAISE NOTICE '   effective=%  recorded=%  cost=%  sku=%',
      r.effective_date, r.recorded_at, r.cost, r.sku;
  END LOOP;
  FOR r IN
    SELECT count(*) FILTER (WHERE cost < 10) AS cheap_rows,
           min(effective_date) FILTER (WHERE cost < 10) AS earliest_cheap_effective
    FROM public.cost_history WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   % cost_history rows under 10.00, earliest effective %',
      r.cheap_rows, r.earliest_cheap_effective;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the override that outranks everything from 2026-05-02 ========';
  FOR r IN
    SELECT unit_cost, effective_from, created_at FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   unit % effective % (created %) -- step 2, beats purchases and listings',
      r.unit_cost, r.effective_from, r.created_at;
  END LOOP;
END
$probe$;
