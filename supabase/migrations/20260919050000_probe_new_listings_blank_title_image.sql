-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: most detections in the new-listings feed have no title and no image
-- (e.g. Plush Island's 94 ASINs detected 2026-09-12). check-seller-watchlist
-- has a backfill (backfillBlankImages) that scans the 60 NEWEST rows with a
-- null image each run and spends up to 12 SP-API lookups. Question: how many
-- blanks are there, how old, and is the newest-first scan starving the tail?

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT count(*) AS total,
                  count(*) FILTER (WHERE image_url IS NULL) AS no_image,
                  count(*) FILTER (WHERE title IS NULL) AS no_title,
                  count(*) FILTER (WHERE title IS NULL AND image_url IS NULL) AS neither,
                  count(*) FILTER (WHERE title IS NOT NULL AND image_url IS NULL) AS title_only,
                  count(*) FILTER (WHERE title IS NULL AND image_url IS NOT NULL) AS image_only
           FROM public.seller_watch_new_listings LOOP
    RAISE NOTICE 'rows % | no image % | no title % | neither % | title but no image % | image but no title %',
      r.total, r.no_image, r.no_title, r.neither, r.title_only, r.image_only;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== blanks (no image) by age ==';
  FOR r IN SELECT CASE WHEN detected_at > now() - interval '1 day' THEN 'a today'
                       WHEN detected_at > now() - interval '7 days' THEN 'b this week'
                       WHEN detected_at > now() - interval '30 days' THEN 'c this month'
                       ELSE 'd older' END AS b,
                  count(*) AS n, min(detected_at)::date AS oldest, max(detected_at)::date AS newest
           FROM public.seller_watch_new_listings WHERE image_url IS NULL GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : % rows (% .. %)', r.b, r.n, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the 60 rows the backfill actually scans (newest first) ==';
  FOR r IN WITH scan AS (
             SELECT * FROM public.seller_watch_new_listings WHERE image_url IS NULL
             ORDER BY detected_at DESC LIMIT 60)
           SELECT count(*) AS n, min(detected_at) AS oldest_in_scan, max(detected_at) AS newest_in_scan,
                  count(*) FILTER (WHERE title IS NULL) AS also_no_title
           FROM scan LOOP
    RAISE NOTICE '  % rows, detected % .. %, of which % have no title', r.n, r.oldest_in_scan, r.newest_in_scan, r.also_no_title;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst sellers for blanks ==';
  FOR r IN SELECT l.seller_id, w.seller_name, count(*) AS blanks, min(l.detected_at)::date AS oldest
           FROM public.seller_watch_new_listings l
           LEFT JOIN LATERAL (SELECT seller_name FROM public.seller_watchlist s
                              WHERE s.seller_id = l.seller_id AND s.marketplace = l.marketplace LIMIT 1) w ON true
           WHERE l.image_url IS NULL GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 8 LOOP
    RAISE NOTICE '  % (%) : % blanks, oldest %', COALESCE(r.seller_name, '?'), r.seller_id, r.blanks, r.oldest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== do we already hold the details elsewhere? ==';
  FOR r IN SELECT count(*) AS blanks,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inventory i WHERE i.asin = l.asin AND i.title IS NOT NULL)) AS in_inventory,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.keepa_catalog_products k WHERE k.asin = l.asin)) AS in_keepa_catalog
           FROM public.seller_watch_new_listings l WHERE l.image_url IS NULL LOOP
    RAISE NOTICE '  % blanks | % have a title in inventory | % in keepa_catalog_products', r.blanks, r.in_inventory, r.in_keepa_catalog;
  END LOOP;
END
$p$;
