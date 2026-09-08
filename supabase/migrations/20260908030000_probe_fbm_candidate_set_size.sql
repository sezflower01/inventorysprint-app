-- PROBE (read-only): size the widened fbm-quick-check candidate set before
-- widening it.
--
-- The current filter is source = 'amazon_sync_fbm' AND available 0/null AND
-- status NOT IN (DELETED, NOT_IN_CATALOG, INCOMPLETE). It misses FBM listings
-- that arrived through the FBA path carrying source = 'live_api'.
--
-- Widening to include live_api is only safe if the resulting set stays small.
-- Each candidate costs one SP-API Listings Items call, the function runs every
-- five minutes, and the account holds 2,986 INACTIVE rows that the current
-- status filter does NOT exclude. Sweeping those every five minutes would be a
-- self-inflicted throttle, so measure each candidate filter first.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== candidate counts under each filter ========';
  FOR r IN
    SELECT
      -- current behaviour
      count(*) FILTER (
        WHERE source = 'amazon_sync_fbm'
          AND COALESCE(available,0) = 0
          AND upper(COALESCE(listing_status,'')) NOT IN ('DELETED','NOT_IN_CATALOG','INCOMPLETE')
      ) AS current_filter,

      -- naive widening: add live_api, keep the same status rule
      count(*) FILTER (
        WHERE source IN ('amazon_sync_fbm','live_api')
          AND COALESCE(available,0) = 0
          AND upper(COALESCE(listing_status,'')) NOT IN ('DELETED','NOT_IN_CATALOG','INCOMPLETE')
      ) AS naive_widened,

      -- widened but ACTIVE only
      count(*) FILTER (
        WHERE source IN ('amazon_sync_fbm','live_api')
          AND COALESCE(available,0) = 0
          AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
      ) AS widened_active_only,

      -- widened, ACTIVE, and nothing committed or in transit. Reserved or
      -- inbound units are proof the SKU is FBA, so those cannot be FBM
      -- candidates and are pure wasted calls.
      count(*) FILTER (
        WHERE source IN ('amazon_sync_fbm','live_api')
          AND COALESCE(available,0) = 0
          AND COALESCE(reserved,0) = 0
          AND COALESCE(inbound,0) = 0
          AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
      ) AS widened_active_no_fba_signal
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   current filter (amazon_sync_fbm only)      : %', r.current_filter;
    RAISE NOTICE '   + live_api, same status rule               : %  <- includes INACTIVE', r.naive_widened;
    RAISE NOTICE '   + live_api, ACTIVE only                    : %', r.widened_active_only;
    RAISE NOTICE '   + live_api, ACTIVE, no reserved/inbound    : %  <- proposed', r.widened_active_no_fba_signal;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== does the proposed filter catch D4M-1H7-45IW? ========';
  FOR r IN
    SELECT sku, source, listing_status, COALESCE(available,0) AS av,
           COALESCE(reserved,0) AS rv, COALESCE(inbound,0) AS ib
    FROM public.inventory
    WHERE user_id = v_uid
      AND source IN ('amazon_sync_fbm','live_api')
      AND COALESCE(available,0) = 0
      AND COALESCE(reserved,0) = 0
      AND COALESCE(inbound,0) = 0
      AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
    ORDER BY created_at DESC LIMIT 20
  LOOP
    RAISE NOTICE '   %  source=%  status=%  a/r/i = %/%/%',
      rpad(r.sku,18), rpad(r.source,16), r.listing_status, r.av, r.rv, r.ib;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== ASINs carrying BOTH an FBA and a non-FBA SKU ========';
  -- These are the rows the dedup currently collapses to one. Sizing the blast
  -- radius of making dedup fulfilment-aware.
  FOR r IN
    WITH tagged AS (
      SELECT asin, sku, source, fnsku,
             (COALESCE(reserved,0) + COALESCE(inbound,0)) > 0 OR fnsku IS NOT NULL AS looks_fba
      FROM public.inventory
      WHERE user_id = v_uid
        AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
    )
    SELECT count(DISTINCT asin) AS asins_with_both
    FROM (
      SELECT asin FROM tagged GROUP BY asin
      HAVING count(*) FILTER (WHERE looks_fba) > 0
         AND count(*) FILTER (WHERE NOT looks_fba) > 0
    ) x
  LOOP
    RAISE NOTICE '   % ACTIVE ASINs carry both an FBA-looking and a non-FBA SKU', r.asins_with_both;
  END LOOP;
END
$probe$;
