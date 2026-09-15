-- COG page: show listings the moment they are saved, "Waiting for Amazon".
--
-- ---- WHY ----------------------------------------------------------------
--
-- The seller created B01LC9A6NS and could not find it on the COG page. It was
-- PENDING_VALIDATION: the page listed only listings passing
-- is_active_created_listing (NULL or ACTIVE). Measured 2026-09-15
-- (20260915061000): over 60 days validation takes a median 21.4 minutes, the
-- 90th percentile 133 minutes, the slowest 27 hours. The seller wants to type
-- the cost straight after saving, not after Amazon confirms.
--
-- ---- DECISIONS (seller, 2026-09-15) -------------------------------------
--
-- * PENDING_VALIDATION listings appear on the page immediately, tagged
--   "Waiting for Amazon". FAILED_VALIDATION listings still do not.
-- * The AUTOMATIC cost fill still waits for Amazon's confirmation. A rejected
--   listing should not get a COG, and 10 have been rejected since May. That is
--   already how cog_on_record_from_listing behaves (it skips inactive listings
--   and fires again on the status change), so the rule is not loosened here.
-- * Typing a COG by hand while a listing waits is allowed. If Amazon later
--   rejects it, the COG row stays but no sale ever uses it.
--
-- ---- ONE RULE CHANGE ----------------------------------------------------
--
-- If the seller types a COG while the listing waits, confirmation later runs
-- the listing through the restock branch (the product now has a COG). A typed
-- average more than 25% from that listing's cost would raise "Price changed"
-- about the very listing the seller just costed. So the flag is skipped when
-- the COG was set or confirmed (reviewed_at) at or after the listing was
-- created: the seller has already made that decision with this listing in
-- view. Imported COGs have no reviewed_at, so genuine restocks still flag.
--
-- Also recreates get_cog_page_products() with awaiting_amazon and
-- pending_listing_count (return type changes, so drop and create).

-- ── the rule ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cog_on_record_from_listing(p_listing_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  l      public.created_listings%ROWTYPE;
  c      public.asin_cog_on_record%ROWTYPE;
  v_unit NUMERIC;
BEGIN
  SELECT * INTO l FROM public.created_listings WHERE id = p_listing_id;
  IF NOT FOUND THEN RETURN 'skipped: listing not found'; END IF;
  IF l.asin IS NULL OR l.asin !~ '^[A-Z0-9]{10}$' THEN RETURN 'skipped: no valid ASIN'; END IF;
  -- Unchanged, and deliberate: nothing automatic happens until Amazon confirms.
  IF NOT public.is_active_created_listing(l.validation_status) THEN RETURN 'skipped: listing not active'; END IF;

  IF COALESCE(l.cost, 0) <= 0 OR COALESCE(l.units, 0) <= 0 THEN
    RETURN 'skipped: no cost on the listing';
  END IF;
  IF l.units > 1 AND l.amount IS NOT NULL AND abs(l.cost - l.amount) < 0.005 THEN
    RETURN 'skipped: unit price typed into the lot-total field';
  END IF;
  v_unit := round((l.cost / l.units)::numeric, 2);
  IF v_unit < 0.10 THEN
    RETURN 'skipped: placeholder cost under $0.10/unit';
  END IF;

  SELECT * INTO c FROM public.asin_cog_on_record WHERE user_id = l.user_id AND asin = l.asin;

  IF NOT FOUND THEN
    INSERT INTO public.asin_cog_on_record
      (user_id, asin, unit_cost, source, title, calculated_cost, calculation)
    VALUES (l.user_id, l.asin, v_unit, 'listing', l.title, v_unit,
            jsonb_build_object(
              'rule', 'auto from listing (20260915050000)',
              'listing_id', l.id,
              'lot_total', l.cost,
              'units', l.units,
              'listing_date', COALESCE(l.date_created::date, l.created_at::date)))
    ON CONFLICT (user_id, asin) DO NOTHING;
    RETURN 'created';
  END IF;

  IF c.unit_cost IS NULL THEN
    IF c.needs_review THEN RETURN 'skipped: product is flagged for manual review'; END IF;
    UPDATE public.asin_cog_on_record
       SET unit_cost = v_unit, source = 'listing', reviewed_at = NULL, calculated_cost = v_unit,
           calculation = jsonb_build_object('rule', 'auto from listing (20260915050000)', 'listing_id', l.id,
                                            'lot_total', l.cost, 'units', l.units,
                                            'listing_date', COALESCE(l.date_created::date, l.created_at::date))
     WHERE id = c.id;
    RETURN 'created';
  END IF;

  IF c.source = 'listing' AND c.reviewed_at IS NULL AND c.calculation ->> 'listing_id' = l.id::text THEN
    IF c.unit_cost IS DISTINCT FROM v_unit THEN
      UPDATE public.asin_cog_on_record
         SET unit_cost = v_unit, calculated_cost = v_unit,
             calculation = c.calculation || jsonb_build_object('lot_total', l.cost, 'units', l.units)
       WHERE id = c.id;
      RETURN 'corrected from its own listing';
    END IF;
    RETURN 'unchanged';
  END IF;

  -- NEW (20260915070000): the seller set or confirmed this COG with this
  -- listing already saved -- typically while it was waiting for Amazon.
  IF c.reviewed_at IS NOT NULL AND c.reviewed_at >= l.created_at THEN
    RETURN 'seller set the COG after this listing was created';
  END IF;

  IF (c.unit_cost > 0 AND abs(v_unit - c.unit_cost) / c.unit_cost > 0.25)
     OR (c.unit_cost = 0 AND v_unit > 0) THEN
    UPDATE public.asin_cog_on_record
       SET price_change_unit_cost = v_unit,
           price_change_units = l.units,
           price_change_listing_id = l.id,
           price_change_detected_at = now()
     WHERE id = c.id;
    RETURN 'price changed';
  END IF;
  RETURN 'restock within 25%';
END;
$fn$;

REVOKE ALL ON FUNCTION public.cog_on_record_from_listing(UUID) FROM PUBLIC, anon, authenticated;

-- ── page function ─────────────────────────────────────────────────────────
-- Body is 20260915050000's with one filter widened and two columns added.

DROP FUNCTION IF EXISTS public.get_cog_page_products();

CREATE FUNCTION public.get_cog_page_products()
RETURNS TABLE (
  asin                     TEXT,
  title                    TEXT,
  image_url                TEXT,
  sku                      TEXT,
  date_created             DATE,
  last_created_at          TIMESTAMPTZ,
  first_listed             DATE,
  listing_count            INTEGER,
  is_restock               BOOLEAN,
  latest_unit_cost         NUMERIC,
  latest_units             NUMERIC,
  latest_lot_date          DATE,
  cog_id                   UUID,
  unit_cost                NUMERIC,
  source                   TEXT,
  needs_review             BOOLEAN,
  review_note              TEXT,
  calculated_cost          NUMERIC,
  calculation              JSONB,
  cog_updated_at           TIMESTAMPTZ,
  in_listings              BOOLEAN,
  reviewed_at              TIMESTAMPTZ,
  price_change_unit_cost   NUMERIC,
  price_change_units       NUMERIC,
  price_change_detected_at TIMESTAMPTZ,
  awaiting_amazon          BOOLEAN,
  pending_listing_count    INTEGER
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
           COALESCE(cl.date_created::date, cl.created_at::date) AS d,
           (cl.validation_status = 'PENDING_VALIDATION') AS pending
    FROM public.created_listings cl
    JOIN me ON cl.user_id = me.uid
    WHERE cl.asin ~ '^[A-Z0-9]{10}$'
      -- Confirmed listings, plus ones still waiting for Amazon. Rejected
      -- (FAILED_VALIDATION) listings stay off the page.
      AND (public.is_active_created_listing(cl.validation_status)
           OR cl.validation_status = 'PENDING_VALIDATION')
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
           bool_or(r.d < r.max_d) AS is_restock,
           count(*) FILTER (WHERE r.pending)::int AS pending_listing_count
    FROM ranked r GROUP BY r.asin
  ), newest AS (
    SELECT r.asin, r.sku, NULLIF(r.title, '') AS title, r.pending FROM ranked r WHERE r.rn_newest = 1
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
         (p.asin IS NOT NULL),
         c.reviewed_at,
         c.price_change_unit_cost,
         c.price_change_units,
         c.price_change_detected_at,
         COALESCE(n.pending, false),
         COALESCE(p.pending_listing_count, 0)
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
  'COG on Record page rows: one per product (confirmed and waiting-for-Amazon Created Listings, plus hand-added COGs), newest listing first. Read-only; scoped to auth.uid().';
