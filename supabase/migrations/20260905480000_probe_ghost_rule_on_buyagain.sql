-- PROBE (read-only): would the shared ghost rule hide legitimate restock
-- candidates from Need Buy Again?
--
-- NeedBuyAgainDialog carries its own local isHiddenInSyncedInventory covering
-- three conditions: NOT_IN_CATALOG, DELETED, and an "amzn.gr." SKU. The shared
-- rule in src/lib/ghostFilter.ts -- whose docstring names "NeedBuyAgain +
-- Repricer parity" but which nothing actually imports -- adds two more:
--     INACTIVE / INCOMPLETE / SUPPRESSED
--     total stock = 0 AND listing_status <> 'ACTIVE'
--
-- The first is plainly the missing filter. The second needs checking BEFORE it
-- is applied, because Buy Again exists to surface items that have RUN OUT, and
-- that clause hides zero-stock rows whose status is anything other than the
-- literal string ACTIVE -- including NULL. If a large number of real restock
-- candidates carry a null or blank listing_status, adopting the shared rule
-- wholesale would empty the list instead of cleaning it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== listing_status distribution on zero-stock rows ========';
  FOR r IN
    SELECT COALESCE(NULLIF(upper(btrim(listing_status)), ''), '(null/blank)') AS status,
           count(*) AS rows,
           count(*) FILTER (WHERE lower(COALESCE(sku,'')) LIKE 'amzn.gr.%') AS amzn_gr
    FROM public.inventory
    WHERE (COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(inbound,0) + COALESCE(unfulfilled,0)) <= 0
    GROUP BY 1 ORDER BY rows DESC LIMIT 15
  LOOP
    RAISE NOTICE '   %-18s : % rows (% are amzn.gr SKUs)', r.status, r.rows, r.amzn_gr;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what each rule would hide, across ALL inventory ========';
  FOR r IN
    SELECT count(*) AS total,
           -- the rule Buy Again uses today
           count(*) FILTER (
             WHERE upper(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
                OR lower(COALESCE(sku,'')) LIKE 'amzn.gr.%') AS hidden_now,
           -- adding only the status clause
           count(*) FILTER (
             WHERE upper(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
                OR lower(COALESCE(sku,'')) LIKE 'amzn.gr.%'
                OR upper(COALESCE(listing_status,'')) IN ('INACTIVE','INCOMPLETE','SUPPRESSED')
                OR upper(COALESCE(listing_status,'')) LIKE '%INACTIVE%') AS hidden_with_status,
           -- the full shared rule, zero-stock clause included
           count(*) FILTER (
             WHERE upper(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
                OR lower(COALESCE(sku,'')) LIKE 'amzn.gr.%'
                OR upper(COALESCE(listing_status,'')) IN ('INACTIVE','INCOMPLETE','SUPPRESSED')
                OR upper(COALESCE(listing_status,'')) LIKE '%INACTIVE%'
                OR ((COALESCE(available,0)+COALESCE(reserved,0)+COALESCE(inbound,0)+COALESCE(unfulfilled,0)) <= 0
                    AND upper(COALESCE(listing_status,'')) <> 'ACTIVE')) AS hidden_full
    FROM public.inventory
  LOOP
    RAISE NOTICE '   % inventory rows | hidden today % | +status clause % | +zero-stock clause %',
      r.total, r.hidden_now, r.hidden_with_status, r.hidden_full;
  END LOOP;

  -- The decisive question: of the rows that ONLY the zero-stock clause would
  -- hide, how many look like genuine restock candidates -- i.e. they have sold
  -- recently and have a supplier link to buy from again?
  RAISE NOTICE '';
  RAISE NOTICE '======== rows ONLY the zero-stock clause would hide ========';
  FOR r IN
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE sales.units_90d > 0) AS sold_in_90d,
           count(*) FILTER (WHERE cl.asin IS NOT NULL)  AS has_created_listing,
           round(sum(sales.units_90d),0) AS units_sold_90d
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(s.quantity),0) AS units_90d
      FROM public.sales_orders s
      WHERE s.user_id = i.user_id AND s.asin = i.asin
        AND s.order_date >= current_date - 90
        AND COALESCE(s.is_cancelled,false) = false
    ) sales ON true
    LEFT JOIN LATERAL (
      SELECT c.asin FROM public.created_listings c
       WHERE c.user_id = i.user_id AND c.asin = i.asin LIMIT 1
    ) cl ON true
    WHERE (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0)) <= 0
      AND upper(COALESCE(i.listing_status,'')) <> 'ACTIVE'
      AND upper(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')
      AND upper(COALESCE(i.listing_status,'')) NOT LIKE '%INACTIVE%'
      AND lower(COALESCE(i.sku,'')) NOT LIKE 'amzn.gr.%'
  LOOP
    RAISE NOTICE '   % rows | % sold something in the last 90 days (% units) | % have a created_listings row',
      r.rows, r.sold_in_90d, r.units_sold_90d, r.has_created_listing;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- a sample of those, worst case for over-filtering --';
  FOR r IN
    SELECT i.asin, i.sku, COALESCE(NULLIF(i.listing_status,''),'(null)') AS status,
           sales.units_90d, left(COALESCE(i.title,''),30) AS title
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(s.quantity),0) AS units_90d
      FROM public.sales_orders s
      WHERE s.user_id = i.user_id AND s.asin = i.asin
        AND s.order_date >= current_date - 90 AND COALESCE(s.is_cancelled,false) = false
    ) sales ON true
    WHERE (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0)) <= 0
      AND upper(COALESCE(i.listing_status,'')) <> 'ACTIVE'
      AND upper(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')
      AND upper(COALESCE(i.listing_status,'')) NOT LIKE '%INACTIVE%'
      AND lower(COALESCE(i.sku,'')) NOT LIKE 'amzn.gr.%'
      AND sales.units_90d > 0
    ORDER BY sales.units_90d DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % sku=% status=% | % units sold in 90d | %',
      r.asin, r.sku, r.status, r.units_90d, r.title;
  END LOOP;
END
$probe$;
