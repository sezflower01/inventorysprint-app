-- PROBE (read-only): we hold 278 distinct ACTIVE ASINs, Seller Central says 189
-- for the US. We have MORE, not fewer, which rules out a sync gap and leaves
-- two candidates that need separating:
--
--   (a) stale carry-over -- rows we marked ACTIVE once and never retired
--   (b) a different definition -- Amazon "Active" excludes out-of-stock, we do
--       not, and 117 of our ACTIVE rows have zero available
--
-- updated_at cannot settle it: any write bumps it, and all 279 were written
-- today. last_inventory_sync_at is the timestamp Amazon actually confirmed the
-- row, so that is the one to read.
--
-- Also worth knowing: the inventory table has NO marketplace column. One row
-- per SKU, shared across all four marketplaces. So "279 ACTIVE" was never a
-- US-only figure to begin with.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== when did Amazon last confirm each ACTIVE row? ========';
  FOR r IN
    SELECT CASE
             WHEN last_inventory_sync_at IS NULL THEN 'never confirmed'
             WHEN last_inventory_sync_at > now() - interval '24 hours' THEN 'last 24h'
             WHEN last_inventory_sync_at > now() - interval '7 days'  THEN '1-7 days'
             WHEN last_inventory_sync_at > now() - interval '30 days' THEN '7-30 days'
             ELSE 'older than 30 days'
           END AS bucket,
           count(*) AS rows_n,
           count(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_stock
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
    GROUP BY 1 ORDER BY rows_n DESC
  LOOP
    RAISE NOTICE '   %  rows=%  of which with stock=%',
      rpad(r.bucket,20), r.rows_n, r.with_stock;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the 117 ACTIVE-but-zero-available, broken down ========';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE COALESCE(reserved,0) > 0) AS has_reserved,
           count(*) FILTER (WHERE COALESCE(inbound,0) > 0) AS has_inbound,
           count(*) FILTER (WHERE COALESCE(unfulfilled,0) > 0) AS has_unfulfilled,
           count(*) FILTER (WHERE COALESCE(reserved,0) = 0
                              AND COALESCE(inbound,0) = 0
                              AND COALESCE(unfulfilled,0) = 0) AS nothing_at_all
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
      AND COALESCE(available,0) = 0
  LOOP
    RAISE NOTICE '   % rows ACTIVE with zero available', r.n;
    RAISE NOTICE '   % have reserved | % have inbound | % have unfulfilled',
      r.has_reserved, r.has_inbound, r.has_unfulfilled;
    RAISE NOTICE '   % have nothing anywhere  <- these should not be ACTIVE', r.nothing_at_all;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== candidate reconciliations against 189 ========';
  FOR r IN
    SELECT
      count(DISTINCT asin) FILTER (WHERE COALESCE(available,0) > 0) AS avail_only,
      count(DISTINCT asin) FILTER (WHERE COALESCE(available,0)
                                      + COALESCE(reserved,0) > 0) AS avail_plus_reserved,
      count(DISTINCT asin) FILTER (WHERE COALESCE(available,0)
                                      + COALESCE(reserved,0)
                                      + COALESCE(unfulfilled,0) > 0) AS avail_res_unful,
      count(DISTINCT asin) FILTER (WHERE COALESCE(available,0)
                                      + COALESCE(reserved,0)
                                      + COALESCE(inbound,0)
                                      + COALESCE(unfulfilled,0) > 0) AS any_units,
      count(DISTINCT asin) AS all_active
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
  LOOP
    RAISE NOTICE '   available > 0                    : %', r.avail_only;
    RAISE NOTICE '   available + reserved             : %', r.avail_plus_reserved;
    RAISE NOTICE '   available + reserved + unfulfilled: %', r.avail_res_unful;
    RAISE NOTICE '   any units anywhere               : %', r.any_units;
    RAISE NOTICE '   every ACTIVE row                 : %', r.all_active;
    RAISE NOTICE '   Seller Central US                : 189';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== do the ACTIVE rows have a live price? ========';
  -- A listing Amazon still shows as active almost always has a Buy Box price.
  -- A row we carry as ACTIVE that has no observed price in weeks is a good
  -- candidate for stale carry-over.
  FOR r IN
    SELECT CASE
             WHEN last_price_confirmed_at IS NULL THEN 'no price ever confirmed'
             WHEN last_price_confirmed_at > now() - interval '7 days' THEN 'priced in last 7d'
             WHEN last_price_confirmed_at > now() - interval '30 days' THEN 'priced 7-30d ago'
             ELSE 'priced over 30d ago'
           END AS bucket,
           count(*) AS n,
           count(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_stock
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'ACTIVE'
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   %  rows=%  with stock=%', rpad(r.bucket,26), r.n, r.with_stock;
  END LOOP;
END
$probe$;
