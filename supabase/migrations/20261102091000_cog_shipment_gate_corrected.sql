-- CORRECTED FEASIBILITY. READ ONLY.
--
-- Two errors in the previous run, and the first one is mine.
--
-- 1. I COMPUTED THE AVERAGE WRONG. I used sum(cost * units) / sum(units),
--    which treats created_listings.cost as a UNIT cost. It is a LINE TOTAL --
--    the cost-contract inversion this repo already documents, and which I had
--    in front of me. Proof: migration 20260919042000's own header records
--    B00A6W0HEQ as "$4.73 = $3,320.44 / 702 over 5 purchases". sum(cost) for
--    that ASIN is 3,320.44, so the average is sum(cost)/sum(units). My version
--    returned $1,354.83 for the same product -- roughly 286x out. Every figure
--    in section 3 of the previous run is void.
--
-- 2. shipment_id IS NULL ON EVERY ALLOCATION ROW -- 628 of 628, across 77
--    drafts. So "confirmed by a real shipment_id" would confirm NOTHING and
--    would strip the average from all 227 products that have one. The literal
--    version of the rule is unusable.
--
--    But units_shipped IS populated: 190 lots, 4,560 units. The builder records
--    what actually went out without ever filling shipment_id. So
--    units_shipped > 0 is the signal that exists, and it is arguably the better
--    one anyway -- it is evidence the units physically moved, not merely that a
--    shipment record was created.
DO $p$
DECLARE r record; v_uid uuid; v_products int; v_lose int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 0. CONFIRM THE COST CONTRACT ########';
  FOR r IN
    SELECT round(sum(cost),2) AS spent, sum(units) AS units,
           round(sum(cost)/NULLIF(sum(units),0),2) AS avg_linetotal,
           count(*) AS lots
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = 'B00A6W0HEQ' AND cost > 0 AND units > 0
      AND created_at >= date_trunc('year', now())
  LOOP
    RAISE NOTICE '   B00A6W0HEQ: sum(cost) % / % units = % over % lots',
      r.spent, r.units, r.avg_linetotal, r.lots;
    RAISE NOTICE '   the migration header says 4.73 = 3,320.44 / 702 over 5.';
    RAISE NOTICE '   if those agree, cost IS a line total and sum(cost)/units';
    RAISE NOTICE '   is the right formula.';
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 1. COVERAGE BY THE SIGNAL THAT EXISTS ########';
  FOR r IN
    SELECT count(*) AS lots,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.shipment_purchase_allocations a
             WHERE a.created_listing_id = cl.id)) AS any_alloc,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.shipment_purchase_allocations a
             WHERE a.created_listing_id = cl.id AND a.units_shipped > 0)) AS shipped,
           round(sum(cl.cost),2) AS spent_all,
           round(sum(cl.cost) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.shipment_purchase_allocations a
             WHERE a.created_listing_id = cl.id AND a.units_shipped > 0)),2) AS spent_shipped
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
      AND cl.created_at >= date_trunc('year', now())
  LOOP
    RAISE NOTICE '   purchase lots this year      : %', r.lots;
    RAISE NOTICE '   with any allocation          : % (% pct)', r.any_alloc,
      round(100.0*r.any_alloc/NULLIF(r.lots,0),1);
    RAISE NOTICE '   with units_shipped > 0       : % (% pct)  <= the usable gate',
      r.shipped, round(100.0*r.shipped/NULLIF(r.lots,0),1);
    RAISE NOTICE '   spend represented: % of % (% pct)',
      r.spent_shipped, r.spent_all,
      round(100.0*r.spent_shipped/NULLIF(r.spent_all,0),1);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. WHAT THE GATE WOULD DO TO THE AVERAGE ########';
  RAISE NOTICE '   asin         | avg now | avg if shipped-only | lots now/shipped';
  FOR r IN
    WITH base AS (
      SELECT cl.asin, cl.id, cl.cost, cl.units,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      WHERE a.created_listing_id = cl.id AND a.units_shipped > 0) AS shipped
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now()))
    SELECT asin,
           round(sum(cost)/NULLIF(sum(units),0),2) AS avg_all,
           round(sum(cost) FILTER (WHERE shipped)
                 / NULLIF(sum(units) FILTER (WHERE shipped),0),2) AS avg_ship,
           count(*) AS lots, count(*) FILTER (WHERE shipped) AS lots_ship
    FROM base GROUP BY asin HAVING count(*) >= 2
    ORDER BY abs(COALESCE(round(sum(cost) FILTER (WHERE shipped)
                  / NULLIF(sum(units) FILTER (WHERE shipped),0),2),0)
                 - round(sum(cost)/NULLIF(sum(units),0),2)) DESC
    LIMIT 12
  LOOP
    RAISE NOTICE '   % | % | % | %/%', rpad(r.asin,12),
      lpad(r.avg_all::text,7),
      lpad(COALESCE(r.avg_ship::text,'none shipped'),19),
      r.lots, r.lots_ship;
  END LOOP;

  WITH base AS (
    SELECT cl.asin,
           EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                    WHERE a.created_listing_id = cl.id AND a.units_shipped > 0) AS shipped
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
      AND cl.created_at >= date_trunc('year', now()))
  SELECT count(*), count(*) FILTER (WHERE no_ship)
    INTO v_products, v_lose
  FROM (SELECT asin, bool_and(NOT shipped) AS no_ship
        FROM base GROUP BY asin HAVING count(*) >= 2) x;
  RAISE NOTICE '';
  RAISE NOTICE '   products with an average today          : %', v_products;
  RAISE NOTICE '   ... with NO shipped lot, so no average  : % (% pct)',
    v_lose, round(100.0*v_lose/NULLIF(v_products,0),1);

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
