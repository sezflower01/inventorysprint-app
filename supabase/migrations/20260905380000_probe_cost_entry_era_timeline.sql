-- PROBE (read-only): do the bad cost entries cluster in a date window?
--
-- The seller reports three eras of data entry: total-amount-divided-by-units,
-- then cost-per-unit entered directly, then back to total-amount (current).
-- If a per-unit number was fed to a field expecting a lot total during the
-- middle era, the damage should be CONCENTRATED IN TIME rather than scattered.
-- That is a falsifiable claim, so test it instead of assuming it.
--
-- The test: for every purchase/listing row with units > 1, derive the unit cost
-- the way the app does (total / units) and compare it to what the item actually
-- sells for. A derived unit under 5% of the lowest observed sale price is not a
-- bargain, it is a lot total that was really a unit price. Bucketed by month.
--
-- Sale price is the yardstick because it is the one number in this system that
-- was never typed by hand -- it comes from Amazon.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '######## created_listing_purchases by month ########';
  RAISE NOTICE 'month     rows  bad   %%bad   median derived unit / median sale price';
  FOR r IN
    WITH px AS (
      SELECT p.id, p.purchase_date::date AS d, p.units, p.total_cost,
             p.total_cost / NULLIF(p.units,0) AS derived_unit,
             sp.min_price
      FROM public.created_listing_purchases p
      JOIN public.created_listings cl ON cl.id = p.listing_id
      LEFT JOIN LATERAL (
        SELECT min(NULLIF(s.item_price,0)) AS min_price
        FROM public.sales_orders s
        WHERE s.user_id = cl.user_id AND s.asin = cl.asin
      ) sp ON true
      WHERE COALESCE(p.units,0) > 1 AND COALESCE(p.total_cost,0) > 0
        AND sp.min_price IS NOT NULL AND sp.min_price > 0
    )
    SELECT to_char(date_trunc('month', d), 'YYYY-MM') AS mon,
           count(*) AS rows,
           count(*) FILTER (WHERE derived_unit < min_price * 0.05) AS bad,
           round(100.0 * count(*) FILTER (WHERE derived_unit < min_price * 0.05) / count(*), 1) AS pct_bad,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY derived_unit)::numeric, 2) AS med_unit,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY min_price)::numeric, 2)   AS med_price
    FROM px
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '%   %  %  %%%   $% / $%',
      r.mon, lpad(r.rows::text,4), lpad(r.bad::text,4), lpad(r.pct_bad::text,5), r.med_unit, r.med_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '######## created_listings by month (cost/units vs sale price) ########';
  RAISE NOTICE 'month     rows  bad   %%bad';
  FOR r IN
    WITH cls AS (
      SELECT cl.id, cl.date_created::date AS d, cl.units, cl.cost,
             cl.cost / NULLIF(cl.units,0) AS derived_unit,
             sp.min_price
      FROM public.created_listings cl
      LEFT JOIN LATERAL (
        SELECT min(NULLIF(s.item_price,0)) AS min_price
        FROM public.sales_orders s
        WHERE s.user_id = cl.user_id AND s.asin = cl.asin
      ) sp ON true
      WHERE COALESCE(cl.units,0) > 1 AND COALESCE(cl.cost,0) > 0
        AND cl.date_created IS NOT NULL
        AND sp.min_price IS NOT NULL AND sp.min_price > 0
    )
    SELECT to_char(date_trunc('month', d), 'YYYY-MM') AS mon,
           count(*) AS rows,
           count(*) FILTER (WHERE derived_unit < min_price * 0.05) AS bad,
           round(100.0 * count(*) FILTER (WHERE derived_unit < min_price * 0.05) / count(*), 1) AS pct_bad
    FROM cls
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '%   %  %  %%%', r.mon, lpad(r.rows::text,4), lpad(r.bad::text,4), lpad(r.pct_bad::text,5);
  END LOOP;

  -- Where exactly do the 6 ASINs' bad rows sit on that timeline?
  RAISE NOTICE '';
  RAISE NOTICE '######## the flagged ASINs: every purchase row, good and bad ########';
  FOR r IN
    SELECT cl.asin, p.purchase_date::date AS d, p.units, p.total_cost,
           round((p.total_cost / NULLIF(p.units,0))::numeric, 4) AS derived_unit,
           round(sp.min_price::numeric, 2) AS min_price,
           CASE WHEN p.total_cost / NULLIF(p.units,0) < sp.min_price * 0.05 THEN 'BAD' ELSE 'ok' END AS flag
    FROM public.created_listing_purchases p
    JOIN public.created_listings cl ON cl.id = p.listing_id
    LEFT JOIN LATERAL (
      SELECT min(NULLIF(s.item_price,0)) AS min_price
      FROM public.sales_orders s WHERE s.user_id = cl.user_id AND s.asin = cl.asin
    ) sp ON true
    WHERE cl.asin IN ('B00JV57NOG','B08BYX3C46','B07VXRVZHH','B002J3OC7S','B00G3MJ0D2','B079STG3DR',
                      'B00074PE6E','B000V2ZXR2','B0012QP8EY','B002IUFSPM')
    ORDER BY p.purchase_date
  LOOP
    RAISE NOTICE '[%] % % units=% total=% -> unit $% (sells from $%)',
      r.flag, r.d, r.asin, r.units, r.total_cost, r.derived_unit, r.min_price;
  END LOOP;

  -- Overall span of the damage.
  RAISE NOTICE '';
  RAISE NOTICE '######## span of bad purchase rows ########';
  FOR r IN
    SELECT count(*) AS bad_rows, min(d) AS earliest, max(d) AS latest
    FROM (
      SELECT p.purchase_date::date AS d
      FROM public.created_listing_purchases p
      JOIN public.created_listings cl ON cl.id = p.listing_id
      LEFT JOIN LATERAL (
        SELECT min(NULLIF(s.item_price,0)) AS min_price
        FROM public.sales_orders s WHERE s.user_id = cl.user_id AND s.asin = cl.asin
      ) sp ON true
      WHERE COALESCE(p.units,0) > 1 AND COALESCE(p.total_cost,0) > 0
        AND sp.min_price > 0 AND p.total_cost / p.units < sp.min_price * 0.05
    ) q
  LOOP
    RAISE NOTICE '% bad purchase rows, spanning % to %', r.bad_rows, r.earliest, r.latest;
  END LOOP;
END
$probe$;
