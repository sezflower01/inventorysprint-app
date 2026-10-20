-- READ-ONLY census. Of the NOT_IN_CATALOG and INACTIVE populations, how many
-- look like B00LFXMBKI -- i.e. genuinely have stock or sales -- and how many
-- are correctly dead?
--
-- The orphan/duplicate split is the whole point. A tombstoned row with an
-- ACTIVE sibling SKU on the same ASIN is CORRECT: it marks a dead duplicate
-- listing, and clearing it would resurrect a second row competing with the
-- live one. Only an ASIN whose every row is dead can be hiding real stock.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the two populations, split by whether a LIVE sibling exists ==';
  FOR r IN
    WITH pop AS (
      SELECT i.asin, i.sku, i.listing_status, COALESCE(i.available,0) AS avail,
             COALESCE(i.cost,0) AS cost,
             EXISTS (SELECT 1 FROM public.inventory s
                     WHERE s.user_id = v_uid AND s.asin = i.asin AND s.id <> i.id
                       AND COALESCE(s.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE')
                       AND COALESCE(s.available,0) > 0) AS has_live_stocked_sibling
      FROM public.inventory i
      WHERE i.user_id = v_uid AND i.listing_status IN ('NOT_IN_CATALOG','INACTIVE')
    )
    SELECT listing_status, has_live_stocked_sibling,
           count(*) AS rows,
           count(*) FILTER (WHERE avail > 0) AS with_stock,
           count(*) FILTER (WHERE cost > 0) AS with_cost
    FROM pop GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '   % | live stocked sibling: % | % rows | % with stock | % with a cost',
      rpad(r.listing_status,15), rpad(r.has_live_stocked_sibling::text,5),
      lpad(r.rows::text,5), lpad(r.with_stock::text,4), r.with_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the answer to the question asked: sold in the last 90 days AND no live sibling ==';
  FOR r IN
    WITH pop AS (
      SELECT i.asin, i.sku, i.listing_status, COALESCE(i.available,0) AS avail,
             COALESCE(i.cost,0) AS cost,
             (SELECT count(*) FROM public.inventory s
              WHERE s.user_id = v_uid AND s.asin = i.asin AND s.id <> i.id
                AND COALESCE(s.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS live_siblings
      FROM public.inventory i
      WHERE i.user_id = v_uid AND i.listing_status IN ('NOT_IN_CATALOG','INACTIVE')
    ), sold AS (
      SELECT asin, count(*) AS orders, sum(quantity) AS units, max(order_date) AS last_sale
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 90
        AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      GROUP BY 1
    )
    SELECT p.listing_status, count(*) AS rows,
           count(*) FILTER (WHERE s.asin IS NOT NULL) AS sold_90d,
           count(*) FILTER (WHERE s.asin IS NOT NULL AND p.live_siblings = 0) AS sold_and_orphan,
           count(*) FILTER (WHERE p.avail > 0) AS has_stock
    FROM pop p LEFT JOIN sold s ON s.asin = p.asin
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | % sold in 90d | % sold AND orphan <<< | % already carry stock',
      rpad(r.listing_status,15), lpad(r.rows::text,5), lpad(r.sold_90d::text,5),
      lpad(r.sold_and_orphan::text,4), r.has_stock;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the orphans that sold in 90d, named (the B00LFXMBKI shortlist) ==';
  FOR r IN
    WITH pop AS (
      SELECT i.asin, i.sku, i.listing_status, COALESCE(i.available,0) AS avail,
             COALESCE(i.cost,0) AS cost, i.updated_at,
             COALESCE(i.last_inventory_sync_at::text,'never') AS last_sync,
             (SELECT count(*) FROM public.inventory s
              WHERE s.user_id = v_uid AND s.asin = i.asin AND s.id <> i.id
                AND COALESCE(s.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS live_siblings
      FROM public.inventory i
      WHERE i.user_id = v_uid AND i.listing_status IN ('NOT_IN_CATALOG','INACTIVE')
    ), sold AS (
      SELECT asin, count(*) AS orders, sum(quantity) AS units, max(order_date) AS last_sale
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 90
        AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      GROUP BY 1
    )
    SELECT p.asin, p.sku, p.listing_status, p.avail, p.cost, p.last_sync,
           s.units, s.last_sale
    FROM pop p JOIN sold s ON s.asin = p.asin
    WHERE p.live_siblings = 0
    ORDER BY s.units DESC NULLS LAST LIMIT 25
  LOOP
    RAISE NOTICE '   % | % | sku % | avail % | cost % | % units/90d | last sale % | sync %',
      r.asin, rpad(r.listing_status,15), rpad(COALESCE(r.sku,'-'),16),
      lpad(r.avail::text,4), lpad(r.cost::text,7),
      lpad(COALESCE(r.units::text,'0'),4), r.last_sale, r.last_sync;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE -- B00LFXMBKI was the only one'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== P&L CONDITION: does any P&L path read public.inventory? ==';
  FOR r IN
    SELECT p.proname,
           (pg_get_functiondef(p.oid) ILIKE '%financial_events_cache%') AS reads_fec,
           (pg_get_functiondef(p.oid) ~* '(from|join)\s+(public\.)?inventory\M') AS reads_inventory
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname ILIKE '%profit%loss%'
    ORDER BY p.proname
  LOOP
    RAISE NOTICE '   %() | reads financial_events_cache: % | reads inventory: %',
      rpad(r.proname,42), rpad(r.reads_fec::text,5), r.reads_inventory;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no function with profit/loss in its name)'; END IF;
END
$p$;
