-- COG page: show the purchase-weighted Average on EVERY product row, not only
-- on "Price changed" ones.
--
-- Seller request 2026-09-19 (example B00A6W0HEQ): COG $4.97 predates a new
-- 400 x $4.55 purchase that is only 8% lower, so it was never flagged and no
-- Average appeared. The seller wants the Average in the row as a button to
-- pick -- never written into the COG on its own ("add it in the record, not
-- in the COG, this way I can select it"). Formula confirmed again: all
-- purchases (total spent / total units, last 12 months when >= 10 units were
-- bought in that window, else all time) -- here $3,320.44 / 702 = $4.73.
-- Sold units need no separate term: every unit sold was one of the purchases.
--
-- Only products with 2+ real purchases get one: with a single purchase the
-- average IS that purchase, already shown in the Latest purchase column.
-- Otherwise identical to 20260918041000.

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
    -- Every product with 2+ real purchases (was: Price changed only).
    SELECT cl.asin
    FROM public.created_listings cl
    JOIN me ON cl.user_id = me.uid
    WHERE cl.cost > 0 AND cl.units > 0
      AND cl.cost / cl.units >= 0.10
      AND NOT (cl.cost = cl.amount AND cl.units > 1)
      AND (public.is_active_created_listing(cl.validation_status)
           OR cl.validation_status = 'PENDING_VALIDATION')
    GROUP BY cl.asin
    HAVING count(*) >= 2
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
  'COG on Record page rows: one per product (confirmed and waiting-for-Amazon Created Listings, plus hand-added COGs), newest listing first. For every product with 2+ real purchases, also a purchase-weighted suggested average (suggested_avg_*), shown as a pick-able button, never auto-applied. Read-only; scoped to auth.uid().';
