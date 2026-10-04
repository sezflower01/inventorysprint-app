-- READ-ONLY PROBE. The June "returns" are corrupt rows, not returns.
--
-- Every large one has the same shape: a -REFUND row with quantity = 1 but
-- refund_quantity = 33..40, sold_price a large negative, and
--   price_source = 'inventory_refresh_forced'
-- written between 24 and 27 June 2026. Example:
--   112-9716594-9995408-REFUND | B0CYR1KRRL | qty 1 | refund_qty 40 | -$778.40
--
-- A refund row cannot return 40 units of an order that sold 1. Something in a
-- forced inventory refresh wrote an inventory-sized quantity into
-- refund_quantity on these rows. The distribution proves it is isolated: every
-- other month averages 1.1 units per refund row with a maximum of 5, and has
-- ZERO rows above 5 units; June averages 4.0 with a maximum of 40.
--
-- This matters well beyond one month. These phantom units inflate the return
-- rate on exactly the ASINs we have been judging all week -- B0CKJNCZLY's
-- "63.5% June" and B077DY3DRM's "77%" -- and a return rate feeds the
-- after-returns ROI that decides whether to reorder.

DO $p$
DECLARE v_uid uuid; r record; v_rows int; v_phantom int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _bad ON COMMIT DROP AS
  SELECT id, order_id, asin, order_date, quantity,
         COALESCE(refund_quantity, 0) AS refund_quantity,
         COALESCE(refund_quantity, 0) - quantity AS phantom_units,
         refund_amount, sold_price, price_source
  FROM public.sales_orders
  WHERE user_id = v_uid
    AND order_id LIKE '%-REFUND'
    AND COALESCE(refund_quantity, 0) > quantity;

  SELECT count(*), COALESCE(sum(phantom_units), 0) INTO v_rows, v_phantom FROM _bad;
  RAISE NOTICE 'rows where refund_quantity exceeds the order quantity: % | phantom units: %',
    v_rows, v_phantom;

  RAISE NOTICE '';
  RAISE NOTICE '== by month and writer ==';
  FOR r IN SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon,
                  COALESCE(price_source, '(none)') AS src,
                  count(*) AS rows, sum(phantom_units) AS phantom
           FROM _bad GROUP BY 1, 2 ORDER BY 4 DESC LOOP
    RAISE NOTICE '  % | % | % rows | % phantom units', r.mon, r.src, r.rows, r.phantom;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== which ASINs are affected, and by how much ==';
  FOR r IN SELECT asin, count(*) AS rows, sum(phantom_units) AS phantom,
                  round(sum(refund_amount)::numeric, 2) AS refund_amount
           FROM _bad GROUP BY asin ORDER BY 3 DESC LIMIT 20 LOOP
    RAISE NOTICE '  % | % row(s) | % phantom units | $% of refund_amount',
      r.asin, r.rows, r.phantom, r.refund_amount;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== corrected return rates for the ASINs judged this week ==';
  FOR r IN
    WITH sold AS (
      SELECT asin, sum(quantity) AS u
      FROM public.sales_orders
      WHERE user_id = v_uid
        AND order_date >= (date_trunc('day', current_date) - interval '12 months')::date
        AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
      GROUP BY asin),
    ret AS (
      SELECT asin,
             sum(CASE WHEN order_id LIKE '%-REFUND'
                      THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                      ELSE COALESCE(refund_quantity, 0) END) AS as_recorded,
             -- the honest count: a -REFUND row returns its own order quantity
             sum(CASE WHEN order_id LIKE '%-REFUND'
                      THEN LEAST(COALESCE(NULLIF(refund_quantity, 0), quantity), quantity)
                      ELSE COALESCE(refund_quantity, 0) END) AS corrected
      FROM public.sales_orders
      WHERE user_id = v_uid
        AND order_date >= (date_trunc('day', current_date) - interval '12 months')::date
        AND COALESCE(is_cancelled, false) = false
      GROUP BY asin)
    SELECT s.asin, s.u AS sold, t.as_recorded, t.corrected,
           round((100.0 * t.as_recorded / NULLIF(s.u, 0))::numeric, 1) AS rate_now,
           round((100.0 * t.corrected / NULLIF(s.u, 0))::numeric, 1) AS rate_fixed
    FROM sold s JOIN ret t ON t.asin = s.asin
    WHERE s.asin IN ('B0CKJNCZLY','B077DY3DRM','B0CYR1KRRL','B08HGZ2HXT','B0G4BQ42W3',
                     'B0B1MXD5ZN','B01BPX8BLK','B09WJHD19B','B000GWG14Q','B077ZYJ3TB',
                     'B00ZQFTTJC','B0002KR11O','B07RQ9QB6K')
    ORDER BY (t.as_recorded - t.corrected) DESC
  LOOP
    RAISE NOTICE '  % | % sold | recorded % (% pct) -> corrected % (% pct)',
      r.asin, r.sold, r.as_recorded, r.rate_now, r.corrected, r.rate_fixed;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== account-wide effect ==';
  FOR r IN
    SELECT sum(quantity) FILTER (WHERE order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price,0) > 0) AS sold,
           sum(CASE WHEN order_id LIKE '%-REFUND'
                    THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                    ELSE COALESCE(refund_quantity, 0) END) AS recorded,
           sum(CASE WHEN order_id LIKE '%-REFUND'
                    THEN LEAST(COALESCE(NULLIF(refund_quantity, 0), quantity), quantity)
                    ELSE COALESCE(refund_quantity, 0) END) AS corrected
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= (date_trunc('day', current_date) - interval '12 months')::date
      AND COALESCE(is_cancelled, false) = false
  LOOP
    RAISE NOTICE '  % units sold | returns recorded % (% pct) -> corrected % (% pct)',
      r.sold, r.recorded, round((100.0 * r.recorded / NULLIF(r.sold, 0))::numeric, 2),
      r.corrected, round((100.0 * r.corrected / NULLIF(r.sold, 0))::numeric, 2);
  END LOOP;
END
$p$;
