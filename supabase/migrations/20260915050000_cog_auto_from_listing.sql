-- COG from listings: auto-fill brand-new products, flag price changes on
-- restocks.
--
-- ---- WHAT THE SELLER ASKED FOR (2026-09-15) -----------------------------
--
-- 1. A brand-new product (no COG yet) gets its COG automatically from its
--    listing's unit cost, so it no longer has to be typed after every new
--    listing.
-- 2. Those COGs are marked "From listing" and stay "Not reviewed" until the
--    seller saves or confirms them, so auto-filled costs remain
--    distinguishable from checked ones -- the reason the seller originally
--    wanted no auto-fill at all.
-- 3. Skip, leaving the product with no COG, when the listing has no cost, a
--    unit cost under $0.10 (placeholder), or the known mix-up where the unit
--    price was typed into the lot-total field (cost equals amount, units > 1).
-- 4. A restock -- a new listing for a product that ALREADY has a COG -- never
--    changes that COG. If its unit cost differs by more than 25%, the product
--    is flagged "Price changed" with the new price, which the page moves to the
--    top and offers as a one-click "Use".
--
-- Explicitly NOT built, agreed with the seller: a running average on
-- restocks. It needs a reliable count of units on hand, and inventory is one
-- pool across four marketplaces.
--
-- ---- WHY THIS IS LOW-RISK ------------------------------------------------
--
-- An auto-filled COG goes through the same trigger as a typed one: it re-prices
-- that product's 2026 sales and is logged. A brand-new product has little or
-- no sales, so a typo in a new listing's cost moves almost nothing, and the
-- "Not reviewed" filter is where it would be caught.
--
-- ---- DETAILS ------------------------------------------------------------
--
-- * Cost Contract A: created_listings.cost is the LOT TOTAL, units the lot
--   size, so unit cost = cost / units.
-- * Fires on INSERT and on UPDATE of cost, units, asin or validation_status. A
--   listing is often created first and costed afterwards in the edit dialog;
--   that edit should fill the COG too.
-- * Correcting the listing that CREATED an auto-filled COG, while the COG is
--   still unreviewed, updates the COG -- it is still "that listing's unit
--   cost". Once the seller has reviewed or typed a COG, listing edits only
--   ever raise the price-change flag.
-- * A COG row that exists with no cost and is flagged needs_review is left
--   alone: that flag means "decide this yourself".
-- * Only listings that pass is_active_created_listing, with a valid ASIN.

-- ── columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.asin_cog_on_record
  DROP CONSTRAINT IF EXISTS asin_cog_on_record_source_check;
ALTER TABLE public.asin_cog_on_record
  ADD CONSTRAINT asin_cog_on_record_source_check CHECK (source IN ('import', 'manual', 'listing'));

ALTER TABLE public.asin_cog_on_record
  ADD COLUMN IF NOT EXISTS reviewed_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS price_change_unit_cost    NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS price_change_units        NUMERIC,
  ADD COLUMN IF NOT EXISTS price_change_listing_id   UUID,
  ADD COLUMN IF NOT EXISTS price_change_detected_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.asin_cog_on_record.reviewed_at IS
  'When the seller confirmed a COG that was filled automatically (source = listing). NULL on such a row = not reviewed.';
COMMENT ON COLUMN public.asin_cog_on_record.price_change_unit_cost IS
  'Unit cost of a restock that differs from this COG by more than 25%. Informational: the COG is never changed by it. Cleared when the seller saves a COG or keeps the current one.';

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

  -- Brand-new product: fill it.
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

  -- A row with no cost: fill it, unless it was set aside for the seller.
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

  -- The listing that created this still-unreviewed COG was corrected.
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

  -- Restock: never touch the COG; flag a big move.
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

CREATE OR REPLACE FUNCTION public.cog_on_record_listing_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.cost IS NOT DISTINCT FROM OLD.cost
     AND NEW.units IS NOT DISTINCT FROM OLD.units
     AND NEW.asin IS NOT DISTINCT FROM OLD.asin
     AND NEW.validation_status IS NOT DISTINCT FROM OLD.validation_status THEN
    RETURN NEW;
  END IF;
  -- Never let the COG side break saving a listing. A failure here is logged
  -- and the listing saves; the COG can always be typed on the page.
  BEGIN
    PERFORM public.cog_on_record_from_listing(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cog_on_record_from_listing failed for listing %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.cog_on_record_listing_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cog_on_record_from_listing ON public.created_listings;
CREATE TRIGGER cog_on_record_from_listing
  AFTER INSERT OR UPDATE OF cost, units, asin, validation_status ON public.created_listings
  FOR EACH ROW EXECUTE FUNCTION public.cog_on_record_listing_trigger();

-- ── history notes for automatic changes ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cog_on_record_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $fn$
DECLARE
  v_n      INTEGER := 0;
  v_uid    UUID := auth.uid();
  v_email  TEXT;
  v_action TEXT;
  v_note   TEXT;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.asin_cog_on_record_history
      (user_id, asin, action, old_unit_cost, new_unit_cost, old_source, new_source,
       sales_rows_repriced, changed_by, changed_by_email)
    VALUES (OLD.user_id, OLD.asin, 'removed', OLD.unit_cost, NULL, OLD.source, NULL,
            0, v_uid, v_email);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost THEN
    RETURN NEW;  -- flag or note edits only; nothing to re-price or log
  END IF;

  IF NEW.unit_cost IS NOT NULL THEN
    v_n := public.apply_cog_on_record_to_sales(NEW.user_id, NEW.asin);
  END IF;

  IF TG_OP = 'INSERT' AND NEW.unit_cost IS NULL THEN
    RETURN NEW;
  END IF;

  v_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'added'
    WHEN NEW.unit_cost IS NULL THEN 'cleared'
    ELSE 'changed' END;

  -- Automatic changes say so, so the log never reads as if the seller typed them.
  IF NEW.source = 'listing' THEN
    v_note := CASE
      WHEN TG_OP = 'INSERT' OR OLD.unit_cost IS NULL
        THEN 'Filled automatically from the product''s listing (cost / units). Not reviewed.'
      ELSE 'Updated automatically after the listing that created it was edited. Not reviewed.' END;
  END IF;

  INSERT INTO public.asin_cog_on_record_history
    (user_id, asin, action, old_unit_cost, new_unit_cost, old_source, new_source,
     sales_rows_repriced, changed_by, changed_by_email, note)
  VALUES (NEW.user_id, NEW.asin, v_action,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.unit_cost END, NEW.unit_cost,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.source END, NEW.source,
          v_n, v_uid, v_email, v_note);
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.cog_on_record_after_change() FROM PUBLIC, anon, authenticated;

-- ── page function: expose review and price-change state ────────────────────
-- Return type changes, so the function must be dropped and recreated. Body is
-- 20260915031000's, with four columns added at the end.

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
  price_change_detected_at TIMESTAMPTZ
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
    FROM public.created_listings cl
    JOIN me ON cl.user_id = me.uid
    WHERE cl.asin ~ '^[A-Z0-9]{10}$'
      AND public.is_active_created_listing(cl.validation_status)
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
         (p.asin IS NOT NULL),
         c.reviewed_at,
         c.price_change_unit_cost,
         c.price_change_units,
         c.price_change_detected_at
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
  'COG on Record page rows: one per product (valid Created Listings plus hand-added COGs), newest listing first, with review and price-change state. Read-only; scoped to auth.uid().';

-- ── catch-up for listings created since the COG page existed ───────────────
--
-- The COGs were loaded at 2026-09-14 20:18 UTC. Listings created after that,
-- before this rule existed, are run through it now, oldest first, exactly as
-- the trigger would have. It can only fill products with no COG and flag
-- restocks; it cannot change a COG the seller typed.

DO $catchup$
DECLARE r record; v_out text;
BEGIN
  FOR r IN
    SELECT l.id, l.asin, l.cost, l.units, l.created_at
    FROM public.created_listings l
    JOIN auth.users u ON u.id = l.user_id AND u.email = 'sezflower01@gmail.com'
    WHERE l.created_at > timestamptz '2026-09-14 20:18:00+00'
    ORDER BY l.created_at
  LOOP
    v_out := public.cog_on_record_from_listing(r.id);
    RAISE NOTICE 'catch-up % % cost=% units=% -> %', r.created_at, r.asin, r.cost, r.units, v_out;
  END LOOP;
END
$catchup$;
