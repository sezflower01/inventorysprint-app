-- B0CKHRZ663: both prices are real, so which batch did the 2026 sales come from?
-- READ ONLY.
--
-- The seller confirms BOTH lots are genuine purchases: 10 units at 17.60 and
-- 5 units at 9.80. That challenges the confirmed-only basis I applied, and
-- rightly:
--
--   confirmed-only       9.80   -- counts the 2026 shipped lot only
--   blended (both lots) (176.00 + 48.99) / 15 = 15.00
--
-- Confirmed-only assumes an unconfirmed lot was never really bought. For a lot
-- that predates the shipment-builder tracking that assumption is FALSE -- the
-- purchase was real, it just has no allocation because the builder was not
-- recording then. So for historical lots the rule drops real cost.
--
-- Which figure is right depends on which units were sold. If the 2026 sales
-- happened BEFORE the September shipment arrived, they came out of the 17.60
-- batch and 9.80 understates their cost materially.
DO $p$
DECLARE r record; v_uid uuid; v_blend numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '######## THE TWO LOTS ########';
  FOR r IN
    SELECT cl.created_at::date AS stamped, cl.units,
           round(cl.cost::numeric,2) AS total,
           round((cl.cost/NULLIF(cl.units,0))::numeric,2) AS unit,
           EXISTS (SELECT 1 FROM public.cog_purchase_confirmations cc
                    WHERE cc.created_listing_id = cl.id) AS confirmed
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid AND cl.asin = 'B0CKHRZ663'
      AND cl.cost > 0 AND cl.units > 0
    ORDER BY cl.created_at
  LOOP
    RAISE NOTICE '   stamped % | % units | total % | %/unit | confirmed %',
      r.stamped, lpad(r.units::text,3), lpad(r.total::text,8),
      lpad(r.unit::text,7), r.confirmed;
  END LOOP;

  SELECT round(sum(cl.cost) / NULLIF(sum(cl.units),0), 2) INTO v_blend
  FROM public.created_listings cl
  WHERE cl.user_id = v_uid AND cl.asin = 'B0CKHRZ663'
    AND cl.cost > 0 AND cl.units > 0;
  RAISE NOTICE '';
  RAISE NOTICE '   confirmed-only (applied) : 9.80';
  RAISE NOTICE '   blended, both lots       : %', v_blend;
  RAISE NOTICE '   2025 lot alone           : 17.60  <- the previous COG';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## WHEN DID THE 2026 UNITS SELL? ########';
  RAISE NOTICE '   the September lot was stamped 2026-09-29. A sale before that';
  RAISE NOTICE '   date cannot have come from it.';
  FOR r IN
    SELECT s.order_date, s.quantity,
           round(COALESCE(s.sold_price,0)::numeric,2) AS price,
           round(COALESCE(s.unit_cost,0)::numeric,2) AS cost_now,
           CASE WHEN s.order_date < '2026-09-29' THEN 'BEFORE the 9.80 lot'
                ELSE 'after' END AS vs_lot
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = 'B0CKHRZ663'
      AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
      AND s.order_id NOT LIKE '%-REFUND%'
    ORDER BY s.order_date
  LOOP
    RAISE NOTICE '   % | % units | sold % | cost now % | %',
      r.order_date, r.quantity, lpad(r.price::text,7),
      lpad(r.cost_now::text,7), r.vs_lot;
  END LOOP;

  FOR r IN
    SELECT count(*) FILTER (WHERE order_date < '2026-09-29') AS before_,
           COALESCE(sum(quantity) FILTER (WHERE order_date < '2026-09-29'),0) AS u_before,
           count(*) FILTER (WHERE order_date >= '2026-09-29') AS after_,
           COALESCE(sum(quantity) FILTER (WHERE order_date >= '2026-09-29'),0) AS u_after
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B0CKHRZ663'
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   sold BEFORE the 9.80 lot existed : % rows, % units',
      r.before_, r.u_before;
    RAISE NOTICE '   sold after                       : % rows, % units',
      r.after_, r.u_after;
    IF r.u_before > 0 THEN
      RAISE NOTICE '';
      RAISE NOTICE '   >>> % units sold before the 9.80 stock existed. Pricing', r.u_before;
      RAISE NOTICE '   >>> them at 9.80 understates their cost. The COG I applied';
      RAISE NOTICE '   >>> is wrong for those units.';
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## HOW WIDE IS THIS? ########';
  RAISE NOTICE '   other ASINs I set from confirmed lots that ALSO have real';
  RAISE NOTICE '   unconfirmed lots -- same question applies to each:';
  FOR r IN
    SELECT count(*) AS asins,
           count(*) FILTER (WHERE lots_unconf > 0) AS with_unconf,
           sum(lots_unconf) AS unconf_lots
    FROM (
      SELECT c.asin,
             count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM public.cog_purchase_confirmations cc
               WHERE cc.created_listing_id = cl.id)) AS lots_unconf
      FROM public.asin_cog_on_record c
      JOIN public.created_listings cl
        ON cl.user_id = c.user_id AND cl.asin = c.asin
       AND cl.cost > 0 AND cl.units > 0
      WHERE c.user_id = v_uid AND c.source = 'auto_shipment'
      GROUP BY c.asin) x
  LOOP
    RAISE NOTICE '   auto_shipment ASINs % | with unconfirmed lots too % | % such lots',
      r.asins, r.with_unconf, r.unconf_lots;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
