-- Fill purchase sources from the purchase history that already exists.
--
-- ---- WHY -----------------------------------------------------------------
--
-- The Purchase sources feature shipped with empty tables and asked the user to
-- type in shops by hand. They already had the data: created_listings
-- .supplier_links holds a real retailer URL per listing -- 7,174 of 8,603
-- listings carry one, complete with discount codes -- and that is where every
-- item was actually bought.
--
-- Measured 2026-09-04: 1,479 distinct brand-to-shop pairs across 1,040 brands.
-- "disney store" resolves to disneystore.com on 23 links, which is exactly the
-- link that was showing "Unavailable".
--
-- Brands really do have several shops, as expected: milwaukee 16, shimano 15,
-- topps 12, lego 9. The many-to-many model holds up against the real data.
--
-- ---- URL CLEANING --------------------------------------------------------
--
-- Some stored links are wrapped in '#' ("#https://www.disneystore.com/...#"),
-- which defeats a naive domain regex and silently produced garbage "domains"
-- that were really whole URLs. Those are stripped before parsing, and anything
-- that still fails to look like a hostname is dropped rather than imported as
-- a broken shop.
--
-- ---- WHY THE TEMPLATE IS THE HOMEPAGE ------------------------------------
--
-- Every shop gets https://<domain> and no placeholder. A search path cannot be
-- guessed per retailer -- target.com uses /s?searchTerm=, walmart.com uses
-- /search?q=, and inventing one for 200 shops would produce links that 404
-- while looking authoritative. The homepage always works, and the UI lets a
-- search path be added per shop where it earns its keep.
--
-- ---- WHY EXISTING ROWS ARE LEFT ALONE ------------------------------------
--
-- ON CONFLICT DO NOTHING throughout. This is an import of history, not a
-- source of truth: anything the user has already entered or edited outranks
-- what is derived here, and re-running must never overwrite their work.

SET statement_timeout TO '600s';

DO $$
DECLARE
  v_pairs bigint; v_shops bigint; v_new_shops bigint; v_new_links bigint;
  v_skipped bigint;
BEGIN
  CREATE TEMP TABLE _derived ON COMMIT DROP AS
  WITH raw AS (
    SELECT c.user_id,
           c.asin,
           -- btrim(x, '#') strips the wrapping hashes; "both ... from" is
           -- trim() syntax and is a syntax error on btrim().
           btrim(btrim(COALESCE(l ->> 'url', l ->> 'link', l #>> '{}')), '#') AS url
    FROM public.created_listings c
    CROSS JOIN LATERAL jsonb_array_elements(c.supplier_links) l
    WHERE jsonb_typeof(c.supplier_links) = 'array'
  ),
  hosts AS (
    SELECT user_id, asin,
           lower(regexp_replace(url, '^https?://(www\.)?([^/?#]+).*$', '\2')) AS domain
    FROM raw
    WHERE url ~* '^https?://'
  )
  SELECT h.user_id, h.domain, lower(btrim(COALESCE(ab.brand, inv.brand))) AS brand_key
  FROM hosts h
  LEFT JOIN public.asin_brand_cache ab ON ab.asin = h.asin
  LEFT JOIN LATERAL (
    SELECT i.brand FROM public.inventory i
     WHERE i.asin = h.asin AND i.brand IS NOT NULL AND btrim(i.brand) <> '' LIMIT 1
  ) inv ON true
  -- A hostname, not a mangled URL fragment.
  WHERE h.domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$';

  DELETE FROM _derived WHERE brand_key IS NULL OR brand_key = '';
  SELECT count(*) INTO v_pairs FROM (SELECT DISTINCT user_id, brand_key, domain FROM _derived) x;
  SELECT count(*) INTO v_shops FROM (SELECT DISTINCT user_id, domain FROM _derived) x;
  RAISE NOTICE 'derived % shops and % brand-to-shop pairs from purchase history',
    v_shops, v_pairs;

  -- Shops. Label reuses whatever source_retailers already calls the domain, so
  -- the two lists read consistently; otherwise the bare domain, which is
  -- honest and recognisable.
  INSERT INTO public.user_retailers (user_id, label, url_template)
  SELECT DISTINCT ON (d.user_id, d.domain)
         d.user_id,
         COALESCE(
           (SELECT sr.label FROM public.source_retailers sr
             WHERE sr.user_id = d.user_id AND sr.domain = d.domain
               AND btrim(COALESCE(sr.label,'')) <> '' LIMIT 1),
           d.domain
         ),
         'https://' || d.domain
  FROM _derived d
  ORDER BY d.user_id, d.domain
  ON CONFLICT (user_id, label) DO NOTHING;

  GET DIAGNOSTICS v_new_shops = ROW_COUNT;

  -- Attachments. The FK is (user_id, brand) against user_brands, so the brand
  -- must carry the user's OWN spelling -- the derived key is lowercased for
  -- matching and would violate it.
  INSERT INTO public.user_brand_sources (user_id, brand, retailer_id, note)
  SELECT DISTINCT ub.user_id, ub.brand, r.id, 'From your purchase history'
  FROM _derived d
  JOIN public.user_brands ub
    ON ub.user_id = d.user_id AND lower(btrim(ub.brand)) = d.brand_key
  JOIN public.user_retailers r
    ON r.user_id = d.user_id AND r.url_template = 'https://' || d.domain
  ON CONFLICT (user_id, brand, retailer_id) DO NOTHING;

  GET DIAGNOSTICS v_new_links = ROW_COUNT;

  -- Brands bought from somewhere but not in the watch list: nothing to attach
  -- to, and inventing user_brands rows would put brands into the seller-watch
  -- filter that the user never chose to watch.
  SELECT count(*) INTO v_skipped FROM (
    SELECT DISTINCT d.brand_key FROM _derived d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_brands ub
       WHERE ub.user_id = d.user_id AND lower(btrim(ub.brand)) = d.brand_key)
  ) x;

  RAISE NOTICE 'imported % shops and % brand links', v_new_shops, v_new_links;
  RAISE NOTICE '% derived brands are not in My Brands, so they were skipped', v_skipped;
END $$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT ub.brand, r2.label
    FROM public.user_brand_sources s
    JOIN public.user_brands ub ON ub.user_id = s.user_id AND ub.brand = s.brand
    JOIN public.user_retailers r2 ON r2.id = s.retailer_id
    WHERE lower(ub.brand) LIKE 'disney%'
    ORDER BY ub.brand, r2.label
  LOOP
    RAISE NOTICE '  % -> %', r.brand, r.label;
  END LOOP;
END $$;
