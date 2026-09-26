-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller wants to drop watched sellers that never add new products, to make
-- room for better ones. Two things have to be separated before anything is
-- deleted:
--   * a seller CHECKED repeatedly that added nothing, and
--   * a seller that only looks idle because it has barely been checked -- the
--     first check of any seller only records a baseline and can never produce
--     detections by design.
-- Deleting the second kind throws away sellers never given a chance.
--
-- (First version used correlated subqueries per seller over 147k detections
-- and hit statement_timeout. One grouped pass instead.)

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now %', now();

  CREATE TEMP TABLE _det AS
  SELECT seller_id, marketplace,
         count(*) AS detections,
         max(detected_at) AS last_detection,
         count(*) FILTER (WHERE detected_at > now() - interval '30 days') AS detections_30d
  FROM public.seller_watch_new_listings
  WHERE user_id = v_uid
  GROUP BY 1, 2;
  CREATE INDEX ON _det (seller_id, marketplace);

  CREATE TEMP TABLE _w AS
  SELECT w.id, w.seller_id, w.marketplace, w.seller_name, w.status,
         w.created_at, w.last_checked_at,
         EXTRACT(EPOCH FROM (now() - w.created_at)) / 86400.0 AS days_watched,
         COALESCE(d.detections, 0) AS detections,
         d.last_detection,
         COALESCE(d.detections_30d, 0) AS detections_30d,
         -- known_asin_list is the baseline recorded on the FIRST check. Its
         -- presence is what separates "checked and added nothing" from
         -- "never really checked".
         (w.known_asin_list IS NOT NULL AND jsonb_array_length(CASE WHEN jsonb_typeof(w.known_asin_list) = 'array' THEN w.known_asin_list ELSE '[]'::jsonb END) > 0) AS has_catalog,
         jsonb_array_length(CASE WHEN jsonb_typeof(w.known_asin_list) = 'array' THEN w.known_asin_list ELSE '[]'::jsonb END) AS baseline_asins
  FROM public.seller_watchlist w
  LEFT JOIN _det d ON d.seller_id = w.seller_id AND d.marketplace = w.marketplace
  WHERE w.user_id = v_uid AND w.status <> 'cancelled';

  FOR r IN SELECT count(*) AS watched,
                  count(*) FILTER (WHERE detections = 0) AS never_added,
                  count(*) FILTER (WHERE detections > 0 AND detections_30d = 0) AS quiet_30d,
                  count(*) FILTER (WHERE detections_30d > 0) AS active_30d,
                  count(*) FILTER (WHERE last_checked_at IS NULL) AS never_checked
           FROM _w LOOP
    RAISE NOTICE 'watched % | never added anything % | added before, nothing in 30d % | active in 30d % | never checked %',
      r.watched, r.never_added, r.quiet_30d, r.active_30d, r.never_checked;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== never-added sellers, by how long they have been watched ==';
  FOR r IN SELECT CASE WHEN days_watched < 7 THEN 'a under 1 week'
                       WHEN days_watched < 30 THEN 'b 1-4 weeks'
                       WHEN days_watched < 60 THEN 'c 1-2 months'
                       ELSE 'd over 2 months' END AS age,
                  count(*) AS sellers,
                  count(*) FILTER (WHERE has_catalog) AS with_catalog,
                  round(avg(days_watched)::numeric, 1) AS avg_days
           FROM _w WHERE detections = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : % sellers (% with a stored catalogue, avg % days watched)', r.age, r.sellers, r.with_catalog, r.avg_days;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== quiet-but-not-empty: added something once, nothing in 30 days ==';
  FOR r IN SELECT count(*) AS n, round(avg(EXTRACT(EPOCH FROM (now() - last_detection)) / 86400.0)::numeric, 0) AS avg_days_since
           FROM _w WHERE detections > 0 AND detections_30d = 0 LOOP
    RAISE NOTICE '  % sellers, last added on average % days ago', r.n, r.avg_days_since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst offenders: watched longest, still nothing ==';
  FOR r IN SELECT COALESCE(seller_name, '(no name)') AS nm, seller_id, marketplace,
                  round(days_watched::numeric, 0) AS days, baseline_asins,
                  to_char(last_checked_at, 'MM-DD HH24:MI') AS last_check
           FROM _w WHERE detections = 0 ORDER BY days_watched DESC LIMIT 12 LOOP
    RAISE NOTICE '  % (%/%) | % days | % ASINs in baseline | last checked %', r.nm, r.seller_id, r.marketplace, r.days, r.baseline_asins, COALESCE(r.last_check, 'never');
  END LOOP;

  DROP TABLE _w; DROP TABLE _det;
END
$p$;
