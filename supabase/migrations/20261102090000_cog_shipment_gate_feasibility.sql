-- WOULD "CONFIRM A PURCHASE WHEN IT IS SHIPPED" WORK AS THE COG TRIGGER?
-- READ ONLY. Nothing changed.
--
-- The seller's idea: today the COG page suggests a purchase-weighted average
-- from created_listings and the seller clicks to accept it. They want it
-- AUTOMATIC, but NOT at the moment a purchase is entered -- because a purchase
-- is sometimes typed in and then never actually bought. Their proposed proof
-- of a real purchase is the FBA Shipment Builder: if units are going to Amazon,
-- the purchase happened.
--
-- The link already exists: shipment_purchase_allocations maps
-- created_listing_id -> draft_id / shipment_id with units_allocated and
-- units_shipped. So the rule is expressible today.
--
-- Before proposing anything, four things have to be measured, because each
-- could sink it:
--   1. COVERAGE -- what share of purchases ever reach an allocation at all? If
--      most do not, the gate would starve the average instead of cleaning it.
--   2. DRAFT vs REAL -- an allocation on a draft is not proof of anything; a
--      draft can be abandoned. Is shipment_id populated often enough to be the
--      gate instead?
--   3. THE DELTA -- how far would the average move if unconfirmed purchases
--      were excluded? If it barely moves, the change is not worth the risk.
--   4. FBM -- items never sent to Amazon can never be confirmed this way. How
--      many purchases are those?
DO $p$
DECLARE
  r record; v_uid uuid;
  v_lots int; v_alloc int; v_ship int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. COVERAGE: do purchases reach an allocation? ########';
  SELECT count(*) INTO v_lots
  FROM public.created_listings
  WHERE user_id = v_uid AND cost > 0 AND units > 0
    AND created_at >= '2026-01-01';
  SELECT count(DISTINCT cl.id) INTO v_alloc
  FROM public.created_listings cl
  JOIN public.shipment_purchase_allocations a ON a.created_listing_id = cl.id
  WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
    AND cl.created_at >= '2026-01-01';
  SELECT count(DISTINCT cl.id) INTO v_ship
  FROM public.created_listings cl
  JOIN public.shipment_purchase_allocations a ON a.created_listing_id = cl.id
  WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
    AND cl.created_at >= '2026-01-01'
    AND a.shipment_id IS NOT NULL AND a.shipment_id <> '';

  RAISE NOTICE '   2026 purchase lots with cost+units : %', v_lots;
  RAISE NOTICE '   ... allocated to a draft OR shipment: % (% pct)', v_alloc,
    round(100.0*v_alloc/NULLIF(v_lots,0),1);
  RAISE NOTICE '   ... allocated to a REAL shipment_id : % (% pct)', v_ship,
    round(100.0*v_ship/NULLIF(v_lots,0),1);
  RAISE NOTICE '   ... with units_shipped > 0          : %',
    (SELECT count(DISTINCT cl.id) FROM public.created_listings cl
      JOIN public.shipment_purchase_allocations a ON a.created_listing_id = cl.id
     WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
       AND cl.created_at >= '2026-01-01' AND a.units_shipped > 0);

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. HOW MANY DRAFTS vs REAL SHIPMENTS? ########';
  FOR r IN
    SELECT CASE WHEN shipment_id IS NULL OR shipment_id = '' THEN 'draft only'
                ELSE 'has shipment_id' END AS kind,
           count(*) AS rows, count(DISTINCT draft_id) AS drafts,
           sum(units_allocated) AS alloc, sum(units_shipped) AS shipped
    FROM public.shipment_purchase_allocations
    WHERE user_id = v_uid GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % rows | % drafts | % allocated | % shipped',
      rpad(r.kind,16), lpad(r.rows::text,5), lpad(r.drafts::text,4),
      lpad(r.alloc::text,7), lpad(r.shipped::text,7);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. THE DELTA: average now vs shipment-confirmed only ########';
  RAISE NOTICE '   asin         | all-purchase avg | confirmed-only avg | diff';
  FOR r IN
    WITH allp AS (
      SELECT cl.asin, sum(cl.cost * cl.units) AS spent, sum(cl.units) AS units,
             count(*) AS lots
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now())
      GROUP BY cl.asin HAVING count(*) >= 2),
    conf AS (
      SELECT cl.asin, sum(cl.cost * cl.units) AS spent, sum(cl.units) AS units,
             count(*) AS lots
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now())
        AND EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                     WHERE a.created_listing_id = cl.id
                       AND a.shipment_id IS NOT NULL AND a.shipment_id <> '')
      GROUP BY cl.asin)
    SELECT a.asin,
           round(a.spent / a.units, 2) AS avg_all,
           CASE WHEN c.units > 0 THEN round(c.spent / c.units, 2) END AS avg_conf,
           a.lots AS lots_all, COALESCE(c.lots,0) AS lots_conf
    FROM allp a LEFT JOIN conf c ON c.asin = a.asin
    WHERE c.asin IS NULL
       OR round(a.spent/a.units,2) <> round(c.spent/c.units,2)
    ORDER BY abs(COALESCE(round(c.spent/NULLIF(c.units,0),2),0)
                 - round(a.spent/a.units,2)) DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '   % | % | % | % (lots %/% )', rpad(r.asin,12),
      lpad(r.avg_all::text,16),
      lpad(COALESCE(r.avg_conf::text,'none confirmed'),18),
      lpad(COALESCE(round(r.avg_conf - r.avg_all,2)::text,'-'),8),
      r.lots_conf, r.lots_all;
  END LOOP;

  FOR r IN
    WITH allp AS (
      SELECT cl.asin, count(*) AS lots FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now())
      GROUP BY cl.asin HAVING count(*) >= 2)
    SELECT count(*) AS products,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.created_listings cl2
             JOIN public.shipment_purchase_allocations a ON a.created_listing_id = cl2.id
             WHERE cl2.user_id = v_uid AND cl2.asin = allp.asin
               AND cl2.created_at >= date_trunc('year', now())
               AND a.shipment_id IS NOT NULL AND a.shipment_id <> '')) AS would_lose_avg
    FROM allp
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   products with an average today        : %', r.products;
    RAISE NOTICE '   ... that would have NONE under the gate: %  <= the cost',
      r.would_lose_avg;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. FBM: purchases that will never be shipped to Amazon ########';
  FOR r IN
    SELECT COALESCE(i.listing_status,'(no inventory row)') AS st,
           count(DISTINCT cl.id) AS lots
    FROM public.created_listings cl
    LEFT JOIN public.inventory i ON i.user_id = v_uid AND i.asin = cl.asin
    WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
      AND cl.created_at >= '2026-01-01'
      AND NOT EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                       WHERE a.created_listing_id = cl.id)
    GROUP BY 1 ORDER BY 2 DESC LIMIT 6
  LOOP
    RAISE NOTICE '   unallocated lots where inventory says % : %', rpad(r.st,18), r.lots;
  END LOOP;
  RAISE NOTICE '   an FBM product is never allocated to an FBA shipment, so the';
  RAISE NOTICE '   gate can never confirm its purchases. Those need a second';
  RAISE NOTICE '   proof or they lose their COG entirely.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
