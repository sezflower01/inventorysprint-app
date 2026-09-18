-- COG page: suggest a purchase-weighted average on "Price changed" products.
--
-- ---- WHY ----------------------------------------------------------------
-- Seller request 2026-09-18: when a restock is flagged "Price changed", offer
-- an average COG next to "Use new" / "Keep", with its formula shown.
-- Example B00LFXMBKI: COG $12.10; lots 3 x $11.67, 24 x $12.16 and the new
-- 240 x $6.37 -> ($35.00 + $291.74 + $1,528.60) / 267 = $6.95.
--
-- Seller chose PURCHASE-weighted over stock-weighted. Stock-weighted uses
-- pooled cross-marketplace on-hand counts the seller already called
-- unreliable (it read $6.37 here only because 0 units were in stock).
-- It is a SUGGESTION: the page copies it into the COG box; only the seller's
-- save makes it the COG. Restocks still never change a COG on their own.
--
-- Return type changes, so DROP + CREATE; grants and comment restored below.
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
  pending_listing_count    INTEGER,
  suggested_avg_cost       NUMERIC,
  suggested_avg_spent      NUMERIC,
  suggested_avg_units      NUMERIC,
  suggested_avg_lots       INTEGER,
  suggested_avg_window     TEXT
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
  ), flagged AS (
    -- Only products flagged "Price changed" get a suggested average, so the
    -- page does not pay for 4,500 aggregates it will never show.
    SELECT c.asin FROM cog c WHERE c.price_change_unit_cost IS NOT NULL
  ), avg_lots AS (
    -- Same purchase rules as the COG import (20260914030000): real lots only.
    -- Placeholders (< $0.10/unit) and the unit-price-in-total mix-up
    -- (cost = amount with units > 1) are dropped; rejected listings too.
    -- No 1/3x..3x outlier trim: the new, cheaper lot is exactly what the
    -- seller is deciding about, so it must count.
    SELECT cl.asin, cl.cost, cl.units, cl.created_at
    FROM public.created_listings cl
    JOIN me ON cl.user_id = me.uid
    JOIN flagged f ON f.asin = cl.asin
    WHERE cl.cost > 0 AND cl.units > 0
      AND cl.cost / cl.units >= 0.10
      AND NOT (cl.cost = cl.amount AND cl.units > 1)
      AND (public.is_active_created_listing(cl.validation_status)
           OR cl.validation_status = 'PENDING_VALIDATION')
  ), avg_window AS (
    SELECT a.asin,
           COALESCE(sum(a.units) FILTER (WHERE a.created_at > now() - interval '365 days'), 0) >= 10 AS use_12m
    FROM avg_lots a GROUP BY a.asin
  ), avg_suggest AS (
    -- Purchase-weighted: total spent / total units. Last 12 months when at
    -- least 10 units were bought in that window (the import's rule), else
    -- all purchases.
    SELECT a.asin,
           round((sum(a.cost) / sum(a.units))::numeric, 2) AS avg_cost,
           round(sum(a.cost)::numeric, 2) AS spent,
           sum(a.units)::numeric AS units,
           count(*)::int AS lots,
           CASE WHEN w.use_12m THEN 'last_12_months' ELSE 'all_time' END AS win
    FROM avg_lots a
    JOIN avg_window w ON w.asin = a.asin
    WHERE NOT w.use_12m OR a.created_at > now() - interval '365 days'
    GROUP BY a.asin, w.use_12m
  ), inv AS (    SELECT DISTINCT ON (i.asin) i.asin, NULLIF(i.image_url, '') AS image_url, NULLIF(i.title, '') AS title
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
         COALESCE(p.pending_listing_count, 0),
         av.avg_cost,
         av.spent,
         av.units,
         av.lots,
         av.win
  FROM keys k
  LEFT JOIN per_asin p  ON p.asin = k.asin
  LEFT JOIN newest n    ON n.asin = k.asin
  LEFT JOIN img         ON img.asin = k.asin
  LEFT JOIN lastcost lc ON lc.asin = k.asin
  LEFT JOIN cog c       ON c.asin = k.asin
  LEFT JOIN inv         ON inv.asin = k.asin
  LEFT JOIN avg_suggest av ON av.asin = k.asin
  ORDER BY p.date_created DESC NULLS LAST, p.last_created_at DESC NULLS LAST, k.asin;
$fn$;

REVOKE ALL ON FUNCTION public.get_cog_page_products() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cog_page_products() TO authenticated;

COMMENT ON FUNCTION public.get_cog_page_products() IS
  'COG on Record page rows: one per product (confirmed and waiting-for-Amazon Created Listings, plus hand-added COGs), newest listing first. For products flagged Price changed, also a purchase-weighted suggested average (suggested_avg_*). Read-only; scoped to auth.uid().';
