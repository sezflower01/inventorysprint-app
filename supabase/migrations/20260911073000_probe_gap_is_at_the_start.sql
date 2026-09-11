-- PROBE (read-only): is the B0G4B3117X gap at the START, not the end?
--
-- Shipment Builder continued 1,320 units for this ASIN, 2026-04-24 .. 06-11.
-- Units that must physically have arrived: sold 1,250 - returned 37 + on hand
-- 312 = ~1,525. The shortfall is ~205.
--
-- Earlier I framed that as entries stopping after mid-June. That looks wrong:
-- Shipment Builder is still in use (Jul 7, Aug 8, Sep 3 continued) and
-- purchase entry continued all year for other products. What IS true is that
-- selling began 2026-03-20 while Builder's first shipment here is 2026-04-24 --
-- so stock arrived before Builder was used for this ASIN.
--
-- The test: walk cumulative sales against cumulative Builder arrivals. Wherever
-- cumulative sales exceed cumulative arrivals, the difference had to come from
-- stock that arrived outside Builder. The largest such deficit is the MINIMUM
-- pre-Builder stock that must have existed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
  v_worst numeric := 0; v_worst_day date;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== cumulative sold vs cumulative shipped-in, by week ========';
  FOR r IN
    WITH arrivals AS (
      SELECT d.created_at::date AS day,
             max(COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric)) AS qty
      FROM public.shipment_builder_drafts d
      CROSS JOIN LATERAL jsonb_path_query(
        d.payload,
        '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
        jsonb_build_object('a', v_asin, 's', v_sku)
      ) AS obj
      WHERE d.user_id = v_uid AND d.status = 'continued'
      GROUP BY d.draft_id, d.created_at::date
    ),
    arr_day AS (SELECT day, sum(qty) AS qty FROM arrivals GROUP BY day),
    sales_day AS (
      SELECT order_date AS day, sum(COALESCE(quantity,1)) AS qty
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin
        AND order_id NOT LIKE '%-REFUND'
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
      GROUP BY order_date
    ),
    days AS (
      SELECT day FROM arr_day UNION SELECT day FROM sales_day
    ),
    joined AS (
      SELECT d.day,
             COALESCE(a.qty,0) AS arrived,
             COALESCE(s.qty,0) AS sold,
             sum(COALESCE(a.qty,0)) OVER (ORDER BY d.day) AS cum_arrived,
             sum(COALESCE(s.qty,0)) OVER (ORDER BY d.day) AS cum_sold
      FROM days d
      LEFT JOIN arr_day a ON a.day = d.day
      LEFT JOIN sales_day s ON s.day = d.day
    )
    SELECT date_trunc('week', day)::date AS wk,
           sum(arrived) AS arrived, sum(sold) AS sold,
           max(cum_arrived) AS cum_arrived, max(cum_sold) AS cum_sold,
           max(cum_sold - cum_arrived) AS worst_deficit
    FROM joined GROUP BY 1 ORDER BY 1
  LOOP
    IF r.worst_deficit > v_worst THEN v_worst := r.worst_deficit; v_worst_day := r.wk; END IF;
    RAISE NOTICE '   week %  in=% out=%  | cumulative in=% out=%  | deficit %',
      r.wk, lpad(r.arrived::text,4), lpad(r.sold::text,4),
      lpad(r.cum_arrived::text,5), lpad(r.cum_sold::text,5), r.worst_deficit;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   WORST deficit: % units, week of %', v_worst, v_worst_day;
  RAISE NOTICE '   -> at least that many units arrived WITHOUT a Shipment Builder record';

  RAISE NOTICE '';
  RAISE NOTICE '======== sales before Shipment Builder was first used here (2026-04-24) ========';
  FOR r IN
    SELECT count(*) AS orders, sum(COALESCE(quantity,1)) AS units,
           min(order_date) AS first_sale
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND order_date < '2026-04-24'
      AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
  LOOP
    RAISE NOTICE '   % units sold in % orders before 2026-04-24 (first sale %)',
      r.units, r.orders, r.first_sale;
    RAISE NOTICE '   every one of those came from stock with no Builder record';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the arithmetic, restated ========';
  RAISE NOTICE '   must have arrived  ~1,525  (sold 1,250 - returns 37 + on hand 312)';
  RAISE NOTICE '   Shipment Builder    1,320  (continued, 2026-04-24 .. 06-11)';
  RAISE NOTICE '   unaccounted           205';
END
$probe$;