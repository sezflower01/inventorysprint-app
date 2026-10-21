-- READ-ONLY. What is actually behind Synced Inventory's "Created" column?
--
-- The frontend resolves it as:
--   inventory.listing_created_at
--     -> else created_listings.date_created      (the Amazon listing date)
--     -> else created_listings.created_at        (when the ROW was inserted,
--                                                 i.e. when the purchase was
--                                                 added to the app)
--
-- That last fallback is the suspect: created_at is a bookkeeping timestamp, not
-- a listing creation date. Where date_created is NULL the column silently
-- switches meaning from "when the listing was created" to "when I added the
-- purchase", and a sort on it then interleaves the two. Measure how often that
-- happens and how far apart the two are before changing any behaviour.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== inventory.listing_created_at coverage ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(listing_created_at) AS have_listing_created,
           count(*) - count(listing_created_at) AS missing,
           round(100.0 * count(listing_created_at) / NULLIF(count(*),0), 1) AS pct
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % inventory rows | % have listing_created_at (% pct) | % fall through',
      r.rows, r.have_listing_created, r.pct, r.missing;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== created_listings: date_created vs created_at ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(date_created) AS have_date_created,
           count(*) - count(date_created) AS falls_back_to_created_at,
           count(*) FILTER (
             WHERE date_created IS NOT NULL
               AND date_created <> (created_at AT TIME ZONE 'UTC')::date
           ) AS differ_from_created_at
    FROM public.created_listings WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % created_listings rows', r.rows;
    RAISE NOTICE '   % have date_created | % have NONE and fall back to created_at',
      r.have_date_created, r.falls_back_to_created_at;
    RAISE NOTICE '   % of the dated ones land on a DIFFERENT day than created_at',
      r.differ_from_created_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how far apart are they, when both exist? ==';
  FOR r IN
    SELECT
      count(*) AS n,
      round(avg(((created_at AT TIME ZONE 'UTC')::date - date_created))::numeric, 1) AS avg_days,
      min((created_at AT TIME ZONE 'UTC')::date - date_created) AS min_days,
      max((created_at AT TIME ZONE 'UTC')::date - date_created) AS max_days,
      count(*) FILTER (WHERE ((created_at AT TIME ZONE 'UTC')::date - date_created) > 30) AS over_30d_apart
    FROM public.created_listings
    WHERE user_id = v_uid AND date_created IS NOT NULL
  LOOP
    RAISE NOTICE '   n % | created_at is on average % days AFTER date_created', r.n, r.avg_days;
    RAISE NOTICE '   range % .. % days | % are more than 30 days apart',
      r.min_days, r.max_days, r.over_30d_apart;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the rows a "most recently created" sort would put on top TODAY ==';
  RAISE NOTICE '   (resolved the same way the frontend does)';
  FOR r IN
    SELECT i.asin, COALESCE(i.sku,'-') AS sku,
           COALESCE(i.listing_created_at::text,'-') AS inv_listing_created,
           COALESCE(cl.date_created::text,'-') AS cl_date_created,
           COALESCE(cl.created_at::text,'-') AS cl_created_at,
           COALESCE(
             i.listing_created_at::text,
             cl.date_created::text,
             cl.created_at::text
           ) AS resolved,
           CASE
             WHEN i.listing_created_at IS NOT NULL THEN 'inventory.listing_created_at'
             WHEN cl.date_created IS NOT NULL THEN 'created_listings.date_created'
             WHEN cl.created_at IS NOT NULL THEN 'created_listings.created_at (PURCHASE ADDED)'
             ELSE '(none - sorts as epoch 0)'
           END AS basis
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT c.date_created, c.created_at FROM public.created_listings c
      WHERE c.user_id = i.user_id AND c.asin = i.asin
      ORDER BY c.created_at DESC LIMIT 1
    ) cl ON true
    WHERE i.user_id = v_uid
    ORDER BY COALESCE(
      i.listing_created_at::text,
      cl.date_created::text,
      cl.created_at::text
    ) DESC NULLS LAST
    LIMIT 15
  LOOP
    RAISE NOTICE '   % | % | resolved % | basis %',
      r.asin, rpad(r.sku,16), rpad(left(r.resolved,10),10), r.basis;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== which basis would each displayed row use? (the mixing problem) ==';
  FOR r IN
    SELECT
      CASE
        WHEN i.listing_created_at IS NOT NULL THEN '1 inventory.listing_created_at'
        WHEN cl.date_created IS NOT NULL THEN '2 created_listings.date_created'
        WHEN cl.created_at IS NOT NULL THEN '3 created_listings.created_at (PURCHASE ADDED)'
        ELSE '4 none - sorts as epoch 0, sinks to the bottom'
      END AS basis,
      count(*) AS rows
    FROM public.inventory i
    LEFT JOIN LATERAL (
      SELECT c.date_created, c.created_at FROM public.created_listings c
      WHERE c.user_id = i.user_id AND c.asin = i.asin
      ORDER BY c.created_at DESC LIMIT 1
    ) cl ON true
    WHERE i.user_id = v_uid
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows', rpad(r.basis,48), r.rows;
  END LOOP;
END
$p$;
