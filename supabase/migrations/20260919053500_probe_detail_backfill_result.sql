-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Read request 119147's response and the blank counts after it.

DO $p$
DECLARE r record; v jsonb;
BEGIN
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 119147;
  IF v IS NULL THEN RAISE NOTICE 'no response yet for 119147'; ELSE
    RAISE NOTICE 'imageBackfill %', v->'imageBackfill';
    RAISE NOTICE 'run: checked % | newListings % | ok %', v->>'checked', v->>'newListings', v->>'ok';
  END IF;

  FOR r IN SELECT count(*) AS total,
                  count(*) FILTER (WHERE title IS NULL) AS no_title,
                  count(*) FILTER (WHERE image_url IS NULL) AS no_image,
                  count(*) FILTER (WHERE details_checked_at IS NOT NULL) AS tried
           FROM public.seller_watch_new_listings LOOP
    RAISE NOTICE 'rows % | no title % | no image % | tried at least once %', r.total, r.no_title, r.no_image, r.tried;
  END LOOP;

  FOR r IN SELECT count(*) AS filled_since FROM public.seller_watch_new_listings
           WHERE details_checked_at > now() - interval '10 minutes' AND image_url IS NOT NULL LOOP
    RAISE NOTICE 'rows tried in the last 10 min that now HAVE an image: %', r.filled_since;
  END LOOP;
END
$p$;
