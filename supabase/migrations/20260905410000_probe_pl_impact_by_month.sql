-- PROBE (read-only): which months' P&L actually moved from tonight's repair?
--
-- The lots are dated 2025. That does NOT mean the P&L impact is 2025: the P&L
-- groups by ORDER DATE, and a lot bought in May 2025 keeps selling for as long
-- as the stock lasts. So the question "does this touch 2026" is about when the
-- ORDERS fell, not when the purchase was entered, and it has to be measured.
--
-- Delta per order = quantity x (corrected unit - the sub-50c value it carried).
-- The old values are listed below from the pre-repair reading. B00JV57NOG had
-- two variants a fraction of a cent apart (0.0881 and 0.09); 0.089 is used, so
-- its figures carry at most a tenth of a cent per unit of error. Every other
-- ASIN had one value.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  CREATE TEMP TABLE _fix (asin text, old_unit numeric, new_unit numeric) ON COMMIT DROP;
  INSERT INTO _fix VALUES
    ('B00JV57NOG', 0.089,   2.29),
    ('B08BYX3C46', 0.10,    2.00),
    ('B07VXRVZHH', 0.1079, 10.79),
    ('B002J3OC7S', 0.4107, 12.32),
    ('B00G3MJ0D2', 0.10,    4.86),
    ('B079STG3DR', 0.25,   14.92);

  RAISE NOTICE '======== P&L impact by month of ORDER DATE ========';
  RAISE NOTICE 'month     orders  units   extra COGS (profit falls by this)';
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date), 'YYYY-MM') AS mon,
           count(*) AS orders,
           sum(COALESCE(s.quantity,1)) AS units,
           round(sum(COALESCE(s.quantity,1) * (f.new_unit - f.old_unit)), 2) AS delta
    FROM public.sales_orders s
    JOIN _fix f ON f.asin = s.asin
    WHERE s.cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '%   %   %    +$%', r.mon, lpad(r.orders::text,4), lpad(r.units::text,4), r.delta;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the same, rolled up by year ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           round(sum(COALESCE(s.quantity,1) * (f.new_unit - f.old_unit)), 2) AS delta
    FROM public.sales_orders s
    JOIN _fix f ON f.asin = s.asin
    WHERE s.cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '%: % orders, % units, +$% COGS', r.yr, r.orders, r.units, r.delta;
  END LOOP;

  -- Does the still-open work reach 2026?
  RAISE NOTICE '';
  RAISE NOTICE '======== OPEN ITEM: the $1 placeholder lots -- order dates ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           count(DISTINCT s.asin) AS asins
    FROM public.sales_orders s
    WHERE s.asin IN (SELECT asin FROM public.created_listings WHERE cost = 1 AND COALESCE(units,0) > 1)
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders / % units across % ASINs', r.yr, r.orders, r.units, r.asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== OPEN ITEM: the inconsistent inventory rows -- order dates ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr,
           count(*) AS orders, sum(COALESCE(s.quantity,1)) AS units,
           count(DISTINCT s.asin) AS asins
    FROM public.sales_orders s
    WHERE s.asin IN (
      SELECT i.asin FROM public.inventory i
       WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
         AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
         AND i.amount / NULLIF(i.units,0) < i.cost)
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders / % units across % ASINs', r.yr, r.orders, r.units, r.asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== OPEN ITEM: the four unresolved 2024 ASINs -- order dates ========';
  FOR r IN
    SELECT EXTRACT(YEAR FROM s.order_date)::int AS yr, count(*) AS orders,
           sum(COALESCE(s.quantity,1)) AS units
    FROM public.sales_orders s
    WHERE s.asin IN ('B00074PE6E','B000V2ZXR2','B0012QP8EY','B002IUFSPM')
      AND COALESCE(s.is_cancelled,false) = false
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % orders / % units', r.yr, r.orders, r.units;
  END LOOP;
END
$probe$;
