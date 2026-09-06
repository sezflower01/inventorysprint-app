-- PROBE (read-only): every created_listings row for the 12 ASINs flagged
-- inconsistent -- not just the flagged row.
--
-- WHY: the flagged rows do not match what the Created Listings page shows.
--   B0792DJ2LB  page: units=100, COG $3.07, total $307.00
--               flagged row: units=50, amount=2.98, cost=2.98
--   B07CB1M6N7  page: units=50,  COG $10.89, total $544.50
--               flagged row: units=50, amount=8.71, cost=8.71
--
-- Units differ on the first one, so the page is not rendering the row the
-- earlier probe found. Either there are several rows per ASIN or the page
-- reads somewhere else. The previous verification asked only "does an
-- independent source match `amount`" and never asked "is this the row the
-- product actually uses" -- so its 12-of-12 result does not mean what it
-- looked like it meant, and no repair should be built on it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '===== ALL created_listings rows for the flagged ASINs =====';
  n := 0;
  FOR r IN
    WITH flagged AS (
      SELECT DISTINCT cl.asin, cl.user_id
      FROM public.created_listings cl
      WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
        AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
    )
    SELECT cl.asin, cl.sku, cl.id, cl.units, cl.amount, cl.cost, cl.date_created, cl.created_at,
           round(cl.amount * cl.units, 2) AS amount_x_units,
           CASE WHEN COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
                 AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
                THEN 'BAD' ELSE 'ok' END AS flag
    FROM public.created_listings cl
    JOIN flagged f ON f.asin = cl.asin AND f.user_id = cl.user_id
    ORDER BY cl.asin, cl.date_created DESC NULLS LAST, cl.created_at DESC
  LOOP
    n := n + 1;
    RAISE NOTICE '[%] % sku=% units=% amount(UNIT)=% cost(TOTAL)=% (amount*units=%) created=% id=%',
      r.flag, r.asin, r.sku, r.units, r.amount, r.cost, r.amount_x_units, r.date_created, r.id;
  END LOOP;
  RAISE NOTICE 'rows: %', n;

  RAISE NOTICE '';
  RAISE NOTICE '===== how many listing rows does each flagged ASIN have? =====';
  FOR r IN
    WITH flagged AS (
      SELECT DISTINCT cl.asin, cl.user_id
      FROM public.created_listings cl
      WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
        AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
    )
    SELECT cl.asin, count(*) AS rows_for_asin,
           count(*) FILTER (
             WHERE abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
           ) AS bad_rows,
           sum(cl.units) AS total_units
    FROM public.created_listings cl
    JOIN flagged f ON f.asin = cl.asin AND f.user_id = cl.user_id
    GROUP BY cl.asin ORDER BY cl.asin
  LOOP
    RAISE NOTICE '% : % listing row(s), % bad, % units total',
      r.asin, r.rows_for_asin, r.bad_rows, r.total_units;
  END LOOP;

  -- The page may be showing purchase history rather than the listing row.
  RAISE NOTICE '';
  RAISE NOTICE '===== created_listing_purchases for these ASINs =====';
  n := 0;
  FOR r IN
    WITH flagged AS (
      SELECT DISTINCT cl.asin, cl.user_id
      FROM public.created_listings cl
      WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
        AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
    )
    SELECT cl.asin, cl.sku, p.units, p.unit_cost, p.total_cost, p.purchase_date, p.note
    FROM public.created_listing_purchases p
    JOIN public.created_listings cl ON cl.id = p.listing_id
    JOIN flagged f ON f.asin = cl.asin AND f.user_id = cl.user_id
    ORDER BY cl.asin, p.purchase_date DESC
  LOOP
    n := n + 1;
    RAISE NOTICE '% sku=% units=% unit_cost=% total_cost=% date=% note=%',
      r.asin, r.sku, r.units, r.unit_cost, r.total_cost, r.purchase_date, r.note;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '(no purchase rows at all)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '================ END PROBE ================';
END
$probe$;
