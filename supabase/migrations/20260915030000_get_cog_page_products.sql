-- One row per product for the COG on Record page: every product with an
-- active Created Listing, plus any product given a COG by hand -- newest
-- listing first, laid out like Synced Inventory.
--
-- ---- WHY ----------------------------------------------------------------
--
-- The page listed asin_cog_on_record rows only, which were loaded once on
-- 2026-09-14. Measured 2026-09-15 (20260915020000): 1,463 of the 4,556 ASINs in
-- Created Listings had no row -- listings saved without a usable cost, which
-- the import rightly skipped -- so they never appeared, and nor would any
-- listing for a new ASIN. The seller wants to create a listing and then find
-- it at the top of the COG page to enter its cost. Sorting could not do that
-- while the rows did not exist.
--
-- ---- DECISIONS (seller, 2026-09-15) -------------------------------------
--
-- * Products come from Created Listings, not from the COG table. A product
--   with no COG shows an EMPTY cost -- it is not auto-filled from the listing
--   cost. The seller types the average after reviewing; an automatic copy
--   would hide which products have actually been reviewed. Its sales keep the
--   Created Listings cost until then.
-- * Newest first by "date created": the newest listing's date_created, falling
--   back to created_at. date_created is the business date the seller sets (it
--   differs from the row's insert time on 5,963 listings, mostly the 2025-11-30
--   bulk load), and it is what Synced Inventory sorts by.
-- * is_restock: the newest listing is not the product's first -- an earlier
--   listing exists on an earlier date. Drives the New / Restock tag.
--
-- ---- DETAILS ------------------------------------------------------------
--
-- * "Active" is active_created_listings, the app's own definition (not
--   FAILED_VALIDATION, not a ghost inventory row).
-- * Latest purchase = the newest listing with a real unit cost: cost / units
--   under Cost Contract A, at least $0.10, since lots under that are the
--   placeholders the import excluded.
-- * Image: newest listing that has one, else inventory's. Title: newest
--   listing's, else the COG row's, else inventory's.
-- * Products with a COG but no active listing (added by hand on the page)
--   are included with no date and sort last.
--
-- SECURITY INVOKER, and every source is filtered to auth.uid() explicitly:
-- active_created_listings is a view, and a view reads its base tables with
-- its owner's rights, so RLS alone would not scope it.
--
-- Reads only. The COG table, its history and sales are not touched.

CREATE OR REPLACE FUNCTION public.get_cog_page_products()
RETURNS TABLE (
  asin              TEXT,
  title             TEXT,
  image_url         TEXT,
  sku               TEXT,
  date_created      DATE,
  last_created_at   TIMESTAMPTZ,
  first_listed      DATE,
  listing_count     INTEGER,
  is_restock        BOOLEAN,
  latest_unit_cost  NUMERIC,
  latest_units      NUMERIC,
  latest_lot_date   DATE,
  cog_id            UUID,
  unit_cost         NUMERIC,
  source            TEXT,
  needs_review      BOOLEAN,
  review_note       TEXT,
  calculated_cost   NUMERIC,
  calculation       JSONB,
  cog_updated_at    TIMESTAMPTZ,
  in_listings       BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH me AS (
    SELECT auth.uid() AS uid
  ), listings AS (
    SELECT cl.asin, cl.sku, cl.title, cl.image_url, cl.cost, cl.units, cl.created_at,
           COALESCE(cl.date_created::date, cl.created_at::date) AS d
    FROM public.active_created_listings cl
    JOIN me ON cl.user_id = me.uid
    WHERE cl.asin ~ '^[A-Z0-9]{10}$'
  ), ranked AS (
    SELECT l.*,
           max(l.d) OVER (PARTITION BY l.asin) AS max_d,
           row_number() OVER (PARTITION BY l.asin ORDER BY l.d DESC, l.created_at DESC) AS rn_newest,
           row_number() OVER (PARTITION BY l.asin
                              ORDER BY (l.image_url IS NULL OR l.image_url = ''), l.d DESC, l.created_at DESC) AS rn_img,
           row_number() OVER (PARTITION BY l.asin
                              ORDER BY (l.cost > 0 AND l.units > 0 AND l.cost / l.units >= 0.10) DESC,
                                       l.d DESC, l.created_at DESC) AS rn_cost
    FROM listings l
  ), per_asin AS (
    SELECT r.asin,
           max(r.d) AS date_created,
           max(r.created_at) AS last_created_at,
           min(r.d) AS first_listed,
           count(*)::int AS listing_count,
           bool_or(r.d < r.max_d) AS is_restock
    FROM ranked r GROUP BY r.asin
  ), newest AS (
    SELECT r.asin, r.sku, NULLIF(r.title, '') AS title FROM ranked r WHERE r.rn_newest = 1
  ), img AS (
    SELECT r.asin, NULLIF(r.image_url, '') AS image_url FROM ranked r WHERE r.rn_img = 1
  ), lastcost AS (
    SELECT r.asin,
           CASE WHEN r.cost > 0 AND r.units > 0 AND r.cost / r.units >= 0.10 THEN round((r.cost / r.units)::numeric, 2) END AS latest_unit_cost,
           CASE WHEN r.cost > 0 AND r.units > 0 AND r.cost / r.units >= 0.10 THEN r.units::numeric END AS latest_units,
           CASE WHEN r.cost > 0 AND r.units > 0 AND r.cost / r.units >= 0.10 THEN r.d END AS latest_lot_date
    FROM ranked r WHERE r.rn_cost = 1
  ), cog AS (
    SELECT c.* FROM public.asin_cog_on_record c JOIN me ON c.user_id = me.uid
  ), inv AS (
    SELECT DISTINCT ON (i.asin) i.asin, NULLIF(i.image_url, '') AS image_url, NULLIF(i.title, '') AS title
    FROM public.inventory i JOIN me ON i.user_id = me.uid
    WHERE i.asin ~ '^[A-Z0-9]{10}$'
    ORDER BY i.asin, (i.image_url IS NULL OR i.image_url = ''), (i.title IS NULL OR i.title = '')
  ), keys AS (
    SELECT p.asin FROM per_asin p
    UNION
    SELECT c.asin FROM cog c
  )
  SELECT k.asin,
         COALESCE(n.title, NULLIF(c.title, ''), inv.title),
         COALESCE(img.image_url, inv.image_url),
         n.sku,
         p.date_created,
         p.last_created_at,
         p.first_listed,
         COALESCE(p.listing_count, 0),
         COALESCE(p.is_restock, false),
         lc.latest_unit_cost,
         lc.latest_units,
         lc.latest_lot_date,
         c.id,
         c.unit_cost,
         c.source,
         c.needs_review,
         c.review_note,
         c.calculated_cost,
         c.calculation,
         c.updated_at,
         (p.asin IS NOT NULL)
  FROM keys k
  LEFT JOIN per_asin p  ON p.asin = k.asin
  LEFT JOIN newest n    ON n.asin = k.asin
  LEFT JOIN img         ON img.asin = k.asin
  LEFT JOIN lastcost lc ON lc.asin = k.asin
  LEFT JOIN cog c       ON c.asin = k.asin
  LEFT JOIN inv         ON inv.asin = k.asin
  ORDER BY p.date_created DESC NULLS LAST, p.last_created_at DESC NULLS LAST, k.asin;
$fn$;

REVOKE ALL ON FUNCTION public.get_cog_page_products() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cog_page_products() TO authenticated;

COMMENT ON FUNCTION public.get_cog_page_products() IS
  'COG on Record page rows: one per product (active Created Listings plus hand-added COGs), newest listing first. Read-only; scoped to auth.uid().';

-- ── verification, AS THE SELLER ─────────────────────────────────────────────
--
-- The seller asked for proof that the 3,093 existing products carry over
-- unchanged: COGs, flags, notes, calculations and history. This migration
-- writes nothing to those tables, so they cannot have changed -- but the
-- question is whether the PAGE will show them unchanged, which means the new
-- function has to return every COG row with identical values. Checked row by
-- row against the table, as the seller under RLS.

DO $verify$
DECLARE
  v_uid uuid;
  r record;
  v_cog_rows int;
  v_hist_rows int;
  v_cog_md5 text;
  v_hist_md5 text;
  t0 timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*), md5(string_agg(concat_ws('|', asin, unit_cost, source, needs_review, review_note,
                                            calculated_cost, calculation::text, updated_at), ',' ORDER BY asin))
    INTO v_cog_rows, v_cog_md5
  FROM public.asin_cog_on_record WHERE user_id = v_uid;
  SELECT count(*), md5(string_agg(concat_ws('|', id, asin, old_unit_cost, new_unit_cost, changed_at), ',' ORDER BY id))
    INTO v_hist_rows, v_hist_md5
  FROM public.asin_cog_on_record_history WHERE user_id = v_uid;
  RAISE NOTICE 'COG table: % rows, fingerprint % | history: % rows, fingerprint %',
    v_cog_rows, left(v_cog_md5, 12), v_hist_rows, left(v_hist_md5, 12);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  t0 := clock_timestamp();
  PERFORM count(*) FROM public.get_cog_page_products();
  RAISE NOTICE 'function as seller: % ms', round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000);

  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE cog_id IS NOT NULL) AS with_cog_row,
           count(*) FILTER (WHERE cog_id IS NULL) AS no_cog_row,
           count(*) FILTER (WHERE in_listings) AS from_listings,
           count(*) FILTER (WHERE NOT in_listings) AS cog_only,
           count(*) FILTER (WHERE image_url IS NULL) AS no_image,
           count(*) FILTER (WHERE title IS NULL) AS no_title,
           count(*) FILTER (WHERE date_created IS NULL) AS no_date,
           count(DISTINCT asin) AS distinct_asins
    FROM public.get_cog_page_products() page_rows
  LOOP
    RAISE NOTICE 'page rows: % (distinct ASINs %) | with COG row % | without % | from listings % | COG-only % | no image % | no title % | no date %',
      r.total, r.distinct_asins, r.with_cog_row, r.no_cog_row, r.from_listings, r.cog_only, r.no_image, r.no_title, r.no_date;
  END LOOP;

  -- The carry-over test: every COG row, every field, identical.
  FOR r IN
    SELECT count(*) AS table_rows,
           count(p.asin) AS found_on_page,
           count(*) FILTER (WHERE p.asin IS NOT NULL AND (
               p.cog_id IS DISTINCT FROM c.id
            OR p.unit_cost IS DISTINCT FROM c.unit_cost
            OR p.source IS DISTINCT FROM c.source
            OR p.needs_review IS DISTINCT FROM c.needs_review
            OR p.review_note IS DISTINCT FROM c.review_note
            OR p.calculated_cost IS DISTINCT FROM c.calculated_cost
            OR p.calculation IS DISTINCT FROM c.calculation
            OR p.cog_updated_at IS DISTINCT FROM c.updated_at)) AS field_mismatches
    FROM public.asin_cog_on_record c
    LEFT JOIN public.get_cog_page_products() p ON p.asin = c.asin
  LOOP
    RAISE NOTICE 'CARRY-OVER: % COG rows | % on the page (must equal) | % with any field different (must be 0)',
      r.table_rows, r.found_on_page, r.field_mismatches;
  END LOOP;

  FOR r IN
    SELECT asin, unit_cost, source, needs_review, left(COALESCE(title, ''), 40) AS t
    FROM public.get_cog_page_products() WHERE asin IN ('B0G4BQ42W3', 'B0G4B3117X', 'B0B4QQDBQC')
    ORDER BY asin
  LOOP
    RAISE NOTICE '  % cog=% source=% review=% | %', r.asin, r.unit_cost, r.source, r.needs_review, r.t;
  END LOOP;

  RAISE NOTICE 'newest first:';
  FOR r IN
    SELECT asin, date_created, listing_count, is_restock, latest_unit_cost, unit_cost,
           image_url IS NOT NULL AS img, left(COALESCE(title, ''), 38) AS t
    FROM public.get_cog_page_products() LIMIT 8
  LOOP
    RAISE NOTICE '  % % lists=% restock=% latest=$% cog=% img=% | %',
      r.date_created, r.asin, r.listing_count, r.is_restock, COALESCE(r.latest_unit_cost::text, '-'),
      COALESCE(r.unit_cost::text, 'none'), r.img, r.t;
  END LOOP;

  FOR r IN
    SELECT count(*) FILTER (WHERE date_created >= current_date - 30 AND NOT is_restock) AS new_30d,
           count(*) FILTER (WHERE date_created >= current_date - 30 AND is_restock) AS restock_30d,
           count(*) FILTER (WHERE date_created >= current_date - 30 AND cog_id IS NULL) AS recent_without_cog
    FROM public.get_cog_page_products()
  LOOP
    RAISE NOTICE 'last 30 days: % new products, % restocks, % of them with no COG yet', r.new_30d, r.restock_30d, r.recent_without_cog;
  END LOOP;

  -- Scoping: another account sees nothing.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_cog_rows FROM public.get_cog_page_products();
  RAISE NOTICE 'as a different account: % rows (must be 0)', v_cog_rows;

  SET LOCAL ROLE postgres;

  SELECT md5(string_agg(concat_ws('|', asin, unit_cost, source, needs_review, review_note,
                                  calculated_cost, calculation::text, updated_at), ',' ORDER BY asin))
    INTO r FROM public.asin_cog_on_record WHERE user_id = v_uid;
  RAISE NOTICE 'COG table fingerprint after: % (must equal %)', left(r.md5, 12), left(v_cog_md5, 12);
  SELECT count(*) AS n, md5(string_agg(concat_ws('|', id, asin, old_unit_cost, new_unit_cost, changed_at), ',' ORDER BY id)) AS h
    INTO r FROM public.asin_cog_on_record_history WHERE user_id = v_uid;
  RAISE NOTICE 'history after: % rows, fingerprint % (must equal % rows, %)', r.n, left(r.h, 12), v_hist_rows, left(v_hist_md5, 12);
END
$verify$;
