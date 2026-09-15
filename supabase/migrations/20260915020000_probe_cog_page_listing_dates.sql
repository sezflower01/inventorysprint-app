-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The seller wants the COG page to look like Synced Inventory: image, title,
-- date created, newest first, so a newly created listing appears at the top
-- and its cost can be entered straight away. Before planning, establish:
--
--   1. whether "date created" is reliable. Synced Inventory uses
--      created_listings.date_created (a DATE) falling back to created_at;
--   2. image and title coverage for the products the page would show;
--   3. THE STRUCTURAL GAP: the COG page lists asin_cog_on_record rows, which
--      were loaded once on 2026-09-14. A listing for a NEW ASIN created after
--      that has no row, so no sort can bring it to the top -- it is not on the
--      page at all. How many are there already?
--   4. what counts as a real listing (drafts, deleted, still-thinking), via the
--      active_created_listings view the app already defines.

DO $probe$
DECLARE v_uid uuid; r record; v_def text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. date_created reliability (created_listings) ========';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE date_created IS NULL) AS no_date,
           count(*) FILTER (WHERE date_created::date > current_date) AS future,
           count(*) FILTER (WHERE date_created::date < '2020-01-01') AS ancient,
           count(*) FILTER (WHERE abs(date_created::date - created_at::date) > 1) AS differs_from_insert,
           count(*) FILTER (WHERE created_at > now() - interval '30 days') AS last_30d
    FROM public.created_listings WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  rows=% | date_created null=% future=% before-2020=% | differs from insert time by >1 day=% | created last 30d=%',
      r.n, r.no_date, r.future, r.ancient, r.differs_from_insert, r.last_30d;
  END LOOP;
  FOR r IN
    SELECT date_created, created_at, asin, left(COALESCE(title, ''), 40) AS t
    FROM public.created_listings
    WHERE user_id = v_uid AND abs(date_created::date - created_at::date) > 1
    ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '    date_created % vs inserted % | % %', r.date_created, r.created_at, r.asin, r.t;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. the listings shown today vs what exists ========';
  FOR r IN
    WITH latest AS (
      SELECT DISTINCT ON (asin) asin, title, image_url, date_created, created_at
      FROM public.created_listings
      WHERE user_id = v_uid AND asin ~ '^[A-Z0-9]{10}$'
      ORDER BY asin, COALESCE(date_created::timestamptz, created_at) DESC, created_at DESC
    )
    SELECT count(*) AS asins,
           count(*) FILTER (WHERE l.image_url IS NULL OR l.image_url = '') AS no_image,
           count(*) FILTER (WHERE l.title IS NULL OR l.title = '') AS no_title,
           count(*) FILTER (WHERE c.asin IS NULL) AS not_on_cog_page,
           count(*) FILTER (WHERE c.asin IS NULL AND l.created_at > timestamptz '2026-09-14 20:18:00+00') AS new_since_import,
           count(*) FILTER (WHERE c.asin IS NOT NULL AND l.created_at > timestamptz '2026-09-14 20:18:00+00') AS restocked_since_import
    FROM latest l
    LEFT JOIN public.asin_cog_on_record c ON c.user_id = v_uid AND c.asin = l.asin
  LOOP
    RAISE NOTICE '  ASINs in Created Listings: % | missing image: % | missing title: %', r.asins, r.no_image, r.no_title;
    RAISE NOTICE '  ASINs with NO row on the COG page: % (of which first listed since the import: %)', r.not_on_cog_page, r.new_since_import;
    RAISE NOTICE '  ASINs already on the COG page with a new listing/purchase since the import: %', r.restocked_since_import;
  END LOOP;

  FOR r IN
    SELECT l.asin, l.date_created, l.created_at, l.units, l.cost, l.validation_status,
           (l.image_url IS NOT NULL AND l.image_url <> '') AS has_img, left(COALESCE(l.title, ''), 45) AS t,
           EXISTS (SELECT 1 FROM public.asin_cog_on_record c WHERE c.user_id = v_uid AND c.asin = l.asin) AS on_cog
    FROM public.created_listings l
    WHERE l.user_id = v_uid AND l.created_at > timestamptz '2026-09-14 20:18:00+00'
    ORDER BY l.created_at DESC LIMIT 12
  LOOP
    RAISE NOTICE '    new: % created % (inserted %) units=% cost=% status=% img=% on_cog=% | %',
      r.asin, r.date_created, r.created_at, r.units, r.cost, r.validation_status, r.has_img, r.on_cog, r.t;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. image fallback coverage for ASINs missing one ========';
  FOR r IN
    WITH noimg AS (
      SELECT DISTINCT asin FROM public.created_listings
      WHERE user_id = v_uid AND asin ~ '^[A-Z0-9]{10}$'
      GROUP BY asin HAVING bool_and(image_url IS NULL OR image_url = '')
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = noimg.asin
                                          AND i.image_url IS NOT NULL AND i.image_url <> '')) AS from_inventory
    FROM noimg
  LOOP
    RAISE NOTICE '  ASINs with no image on any listing: % | of which inventory has one: %', r.n, r.from_inventory;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. what "active" means in this app ========';
  BEGIN
    SELECT pg_get_viewdef('public.active_created_listings'::regclass, true) INTO v_def;
    RAISE NOTICE '  active_created_listings = %', regexp_replace(v_def, '\s+', ' ', 'g');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  active_created_listings unreadable: %', SQLERRM;
  END;
  FOR r IN
    SELECT COALESCE(validation_status, '(null)') AS st, count(*) AS n,
           count(*) FILTER (WHERE created_at > now() - interval '30 days') AS recent
    FROM public.created_listings WHERE user_id = v_uid
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '  validation_status % : % rows (% in last 30 days)', rpad(r.st, 22), r.n, r.recent;
  END LOOP;
END
$probe$;
