-- Where you actually buy each brand, so a matched listing links to your real
-- supplier instead of a generic Google search.
--
-- ---- WHY RETAILERS AND NOT A URL COLUMN ---------------------------------
--
-- Two reasons a `user_brands.purchase_url` column was rejected.
--
-- First, brands have MORE THAN ONE source -- the same brand is bought from
-- several retailers, and a column holds one value.
--
-- Second, scale. Measured 2026-09-03: 4,088 active brands, 4,087 stocked, and
-- 2,185 of them appear on a watched seller's catalogue. A per-brand URL field
-- means up to 2,185 URLs typed by hand. Modelling the RETAILER once and
-- attaching brands to it turns that into one URL per store plus a click per
-- brand.
--
-- ---- NAMING ------------------------------------------------------------
--
-- Not `source`. user_brands.source already exists and means PROVENANCE
-- ('inventory' vs 'manual'). Reusing the word for "shop I buy from" would put
-- two unrelated meanings on one noun in the same table's vocabulary.
--
-- refresh_user_brands() only ever updates the count columns and explicitly
-- never touches user-entered ones, so nothing here is at risk from the
-- nightly refresh. These live in their own tables regardless.
--
-- ---- RLS ---------------------------------------------------------------
--
-- Full owner policies from the start, deliberately. seller_catalog_queue was
-- created earlier today with RLS on and NO policies, which is deny-all, and a
-- SECURITY INVOKER function reading it silently returned zero rows in the
-- browser while the service role saw 737 -- a bug that looked like a date
-- filter. These are user data read directly by the client, so they get
-- explicit policies for every operation.

CREATE TABLE IF NOT EXISTS public.user_retailers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label        text NOT NULL,
  -- Optional {brand} / {title} placeholders. No placeholder = open as-is,
  -- which is how a plain homepage is expressed. One field covers homepage,
  -- brand search and title search rather than three columns and a mode flag.
  url_template text NOT NULL CHECK (url_template ~* '^https?://'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, label)
);

CREATE TABLE IF NOT EXISTS public.user_brand_sources (
  user_id     uuid NOT NULL,
  brand       text NOT NULL,
  retailer_id uuid NOT NULL REFERENCES public.user_retailers(id) ON DELETE CASCADE,
  -- "case pack only", "clearance aisle", "call ahead". Shown beside the link,
  -- because the caveat is useless anywhere else.
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brand, retailer_id),
  FOREIGN KEY (user_id, brand)
    REFERENCES public.user_brands(user_id, brand) ON DELETE CASCADE
);

-- Listings carry Amazon's brand string, which differs in case and padding from
-- what the user typed. Every lookup normalises, so the index must too.
CREATE INDEX IF NOT EXISTS user_brand_sources_lookup_idx
  ON public.user_brand_sources (user_id, lower(btrim(brand)));
CREATE INDEX IF NOT EXISTS user_brand_sources_retailer_idx
  ON public.user_brand_sources (retailer_id);

ALTER TABLE public.user_retailers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_brand_sources  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own retailers" ON public.user_retailers;
CREATE POLICY "own retailers" ON public.user_retailers
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "own brand sources" ON public.user_brand_sources;
CREATE POLICY "own brand sources" ON public.user_brand_sources
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- One call returns every attachment with its retailer, so the client can build
-- a brand -> sources map once instead of querying per listing row. Returns
-- jsonb rather than a table: PostgREST caps RPC rows at 1,000, which silently
-- truncated a 737-item list earlier today, and a user with 2,185 branded
-- attachments would hit that ceiling without any error to show for it.
CREATE OR REPLACE FUNCTION public.get_brand_sources()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_object_agg(k, entries), '{}'::jsonb)
  FROM (
    SELECT lower(btrim(s.brand)) AS k,
           jsonb_agg(
             jsonb_build_object(
               'retailer_id', r.id,
               'label',       r.label,
               'template',    r.url_template,
               'note',        s.note
             ) ORDER BY r.label
           ) AS entries
    FROM public.user_brand_sources s
    JOIN public.user_retailers r ON r.id = s.retailer_id
    WHERE s.user_id = auth.uid()
    GROUP BY lower(btrim(s.brand))
  ) t;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_brand_sources() TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'user_retailers and user_brand_sources created, owner-scoped RLS on both.';
END $$;
