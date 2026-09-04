-- A shared catalogue every tenant inherits, plus per-user opt-outs.
--
-- ---- WHAT IS SHARED, AND WHAT DELIBERATELY IS NOT -----------------------
--
-- SHARED, admin-curated, visible to every user:
--   * retailers -- shop name + URL pattern. "Target exists and its search
--     lives at /s?searchTerm=" is public knowledge, and making every new
--     tenant retype it is pure friction.
--   * excluded terms -- categories and keywords not worth sourcing.
--
-- PRIVATE, never shared, stays on the account that created it:
--   * the brand list itself
--   * brand -> retailer mappings
--   * anything derived from purchase history
--
-- That split is a business decision, not a technical one. The brand list and
-- the brand-to-supplier mapping ARE the sourcing research this product is
-- built on; handing them to every subscriber would teach each of them to buy
-- the same stock from the same shops. The retailer and category structure
-- carries none of that and is worth sharing for onboarding alone.
--
-- ---- NO DISCOUNT CODES, STRUCTURALLY -----------------------------------
--
-- catalog_retailers has NO discount column and never will. Discounts in this
-- database come from created_listings.supplier_links, are time-limited, and
-- are tied to one buyer's relationship with a shop -- they would be stale or
-- simply invalid for anyone else. A shared retailer is a plain shop link; a
-- user finds their own deals. There is nowhere here to put a code even by
-- accident, which is the point.
--
-- ---- WHY A SEPARATE TABLE RATHER THAN A shared FLAG --------------------
--
-- user_brands carries asin_count / unit_count / inbound_count, refreshed from
-- each user's own inventory. A `shared` flag on that table would put one
-- tenant's stock levels one policy mistake away from every other tenant.
-- Separate tables make that leak structurally impossible rather than merely
-- prevented.
--
-- ---- PROPAGATION IS A READ, NOT A SYNC ---------------------------------
--
-- Nothing is copied into user accounts. Effective list = shared UNION own
-- MINUS muted, resolved at read time, so a row added here appears for every
-- user on their next load with no job, no backfill and no drift.

-- ---- SHARED RETAILERS ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.catalog_retailers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text NOT NULL UNIQUE,
  -- Same {brand} / {title} placeholder contract as user_retailers. No
  -- placeholder means open the page as-is.
  url_template text NOT NULL CHECK (url_template ~* '^https?://'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- SHARED EXCLUSIONS --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.catalog_excluded_terms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('category', 'brand', 'title_keyword')),
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

-- ---- PER-USER OPT-OUTS --------------------------------------------------
--
-- Without this a single bad shared entry becomes every tenant's problem with
-- no escape short of an admin edit. Muting is per-user and never deletes the
-- shared row.
CREATE TABLE IF NOT EXISTS public.user_catalog_mutes (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('retailer', 'excluded_term')),
  target_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, target_id)
);

ALTER TABLE public.catalog_retailers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_excluded_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_catalog_mutes     ENABLE ROW LEVEL SECURITY;

-- Everyone reads the catalogue; only admins change it.
DROP POLICY IF EXISTS "read catalog retailers" ON public.catalog_retailers;
CREATE POLICY "read catalog retailers" ON public.catalog_retailers
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admins write catalog retailers" ON public.catalog_retailers;
CREATE POLICY "admins write catalog retailers" ON public.catalog_retailers
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "read catalog terms" ON public.catalog_excluded_terms;
CREATE POLICY "read catalog terms" ON public.catalog_excluded_terms
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admins write catalog terms" ON public.catalog_excluded_terms;
CREATE POLICY "admins write catalog terms" ON public.catalog_excluded_terms
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "own mutes" ON public.user_catalog_mutes;
CREATE POLICY "own mutes" ON public.user_catalog_mutes
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---- ATTACHING A BRAND TO A SHARED SHOP ---------------------------------
--
-- user_brand_sources.retailer_id previously had a hard FK to user_retailers.
-- A brand can now point at a shared shop instead, so the column carries a
-- scope and the FK is dropped -- a single column cannot reference two tables.
--
-- The trade is deliberate: without the FK a deleted retailer leaves an orphan
-- row, but every read path JOINs the retailer, so an orphan simply stops
-- appearing. Losing a link is recoverable; a polymorphic FK or a copy of every
-- shared shop into every account is not.
ALTER TABLE public.user_brand_sources
  ADD COLUMN IF NOT EXISTS retailer_scope text NOT NULL DEFAULT 'user'
  CHECK (retailer_scope IN ('user', 'catalog'));

DO $$
DECLARE v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'public.user_brand_sources'::regclass
    AND contype = 'f'
    AND confrelid = 'public.user_retailers'::regclass
  LIMIT 1;
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_brand_sources DROP CONSTRAINT %I', v_con);
    RAISE NOTICE 'dropped FK % so a brand can point at a shared shop', v_con;
  END IF;
END $$;

-- ---- SEED THE SHARED SHOPS ----------------------------------------------
--
-- source_retailers already holds curated, human-labelled domains (Walmart,
-- Target, Best Buy, Home Depot) from before this feature existed. Seeding from
-- there rather than from the 659 shops imported from purchase history is
-- deliberate: those are one account's real supplier list, which is exactly the
-- research that stays private.
INSERT INTO public.catalog_retailers (label, url_template)
SELECT DISTINCT ON (lower(btrim(sr.domain)))
       COALESCE(NULLIF(btrim(sr.label), ''), sr.domain),
       'https://' || lower(btrim(sr.domain))
FROM public.source_retailers sr
WHERE sr.domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$'
ORDER BY lower(btrim(sr.domain)), sr.search_hits DESC
ON CONFLICT (label) DO NOTHING;

DO $$
DECLARE v_shops bigint; v_terms bigint;
BEGIN
  SELECT count(*) INTO v_shops FROM public.catalog_retailers;
  SELECT count(*) INTO v_terms FROM public.catalog_excluded_terms;
  RAISE NOTICE 'shared catalogue: % retailers, % excluded terms', v_shops, v_terms;
END $$;
