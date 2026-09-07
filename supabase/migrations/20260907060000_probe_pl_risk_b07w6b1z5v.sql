-- PROBE (read-only): why does Private-Label Risk say "Not enough data" for
-- B07W6B1Z5V when the Keepa price chart is full?
--
-- The PL model does not read the price chart. It reads two other series that
-- mobile-scan-price-history derives from the SAME Keepa response:
--   sellerHistory    <- csv[COUNT_NEW]              (offer-count history)
--   buyBoxOwnership  <- product.buyBoxSellerIdHistory + stats.buyBoxStats
--
-- So a rich price chart proves nothing about these. This reads the cached
-- payload to see which of the two is missing or thin -- and whether it is
-- missing for THIS ASIN only or for everything, which is the difference
-- between an untracked product and a broken request.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== cached rows for B07W6B1Z5V ========';
  n := 0;
  FOR r IN
    SELECT asin, marketplace, days_range, fetched_at, expires_at,
           (SELECT count(*) FROM jsonb_object_keys(series)) AS series_keys,
           (series -> 'sellerHistory')   IS NOT NULL AS has_seller_hist,
           (series -> 'buyBoxOwnership') IS NOT NULL AS has_bb_ownership
    FROM public.keepa_price_history_cache
    WHERE asin = 'B07W6B1Z5V'
    ORDER BY fetched_at DESC
  LOOP
    n := n + 1;
    RAISE NOTICE '   % / % days=% fetched % | % series keys | sellerHistory=% | buyBoxOwnership=%',
      r.asin, r.marketplace, r.days_range, r.fetched_at, r.series_keys,
      r.has_seller_hist, r.has_bb_ownership;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (nothing cached for this ASIN -- the panel fetched live)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== the two series in detail ========';
  FOR r IN
    SELECT marketplace,
           left(jsonb_pretty(series -> 'sellerHistory'), 700)   AS sh,
           left(jsonb_pretty(series -> 'buyBoxOwnership'), 700) AS bb
    FROM public.keepa_price_history_cache
    WHERE asin = 'B07W6B1Z5V' ORDER BY fetched_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '   marketplace %', r.marketplace;
    RAISE NOTICE '   sellerHistory   = %', COALESCE(r.sh, '(absent)');
    RAISE NOTICE '   buyBoxOwnership = %', COALESCE(r.bb, '(absent)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== across the whole cache: how common is this? ========';
  FOR r IN
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE series -> 'sellerHistory'   IS NOT NULL) AS with_seller_hist,
           count(*) FILTER (WHERE series -> 'buyBoxOwnership' IS NOT NULL) AS with_bb_ownership,
           count(*) FILTER (WHERE series -> 'sellerHistory' IS NOT NULL
                              AND series -> 'buyBoxOwnership' IS NOT NULL) AS with_both
    FROM public.keepa_price_history_cache
  LOOP
    RAISE NOTICE '   % cached ASINs | sellerHistory on % | buyBoxOwnership on % | both on %',
      r.rows, r.with_seller_hist, r.with_bb_ownership, r.with_both;
    IF r.rows > 0 AND r.with_both = 0 THEN
      RAISE NOTICE '   -> NOT ONE cached row has both. That points at the request or the';
      RAISE NOTICE '      Keepa plan, not at this product being untracked.';
    ELSIF r.rows > 0 THEN
      RAISE NOTICE '   -> other ASINs DO carry the data, so the request works; this one is thin.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== a few that DO have it, for contrast ========';
  n := 0;
  FOR r IN
    SELECT asin, marketplace,
           left(jsonb_pretty(series -> 'buyBoxOwnership'), 260) AS bb
    FROM public.keepa_price_history_cache
    WHERE series -> 'buyBoxOwnership' IS NOT NULL
    ORDER BY fetched_at DESC LIMIT 3
  LOOP
    n := n + 1;
    RAISE NOTICE '   % / % : %', r.asin, r.marketplace, r.bb;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no cached ASIN anywhere carries buyBoxOwnership)'; END IF;
END
$probe$;
