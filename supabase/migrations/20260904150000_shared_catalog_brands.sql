-- Shared brand catalogue: the admin's curated list, inherited by every user
-- on top of the brands their own inventory produces.
--
-- ---- WHY THIS IS ADDITIVE, NOT A REPLACEMENT ---------------------------
--
-- user_brands is a projection of a user's own stock -- refresh_user_brands()
-- reads their inventory and writes one row per brand held. Measured
-- 2026-09-04: 4,123 of 4,124 rows came from inventory, exactly ONE was typed
-- by hand. Every account already has its own list (1,485 / 1,322 / 1,317
-- brands) derived from its own stock.
--
-- So the shared catalogue does not replace that, it adds to it. A user's
-- effective brands = their own inventory brands UNION the shared list MINUS
-- anything they muted. Someone who stocks Milwaukee still matches Milwaukee
-- whether or not it is in the catalogue; the catalogue widens the net to
-- brands worth watching that they do not yet carry.
--
-- ---- THE READ SURFACE IS WIDER THAN SHOPS OR CATEGORIES ----------------
--
-- Retailers had one consumer and exclusions had three. Brands drive the
-- MATCH itself, so every one of these has to move together or they disagree
-- about what counts as "my brand":
--
--   check-seller-watchlist            price capture + alerting
--   classify-listing-brands           brand_match_state on each detection
--   refresh_seller_brand_catalog_rollup   the Seller catalogue counts
--   get_seller_brand_items            the per-seller item list
--
-- get_effective_brands_for() is the single definition they all call, so a
-- future change lands in one place rather than four.
--
-- ---- A CONSEQUENCE WORTH KNOWING ---------------------------------------
--
-- Sharing ~1,485 brands means every user's filter matches against brands they
-- may not stock, which widens the feed considerably. That is the point of a
-- curated starter list, but it is also why per-brand muting exists: without
-- it a user could not narrow the net back down to what they actually sell.

CREATE TABLE IF NOT EXISTS public.catalog_brands (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand      text NOT NULL,
  -- Same contract as user_brands.match_mode: 'exact' or 'prefix'.
  match_mode text NOT NULL DEFAULT 'exact' CHECK (match_mode IN ('exact', 'prefix')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Case-insensitively unique: "Nerf" and "nerf" are one brand, and two rows
  -- would double every match downstream.
  CONSTRAINT catalog_brands_brand_key UNIQUE (brand)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_brands_lower_idx
  ON public.catalog_brands (lower(btrim(brand)));

ALTER TABLE public.catalog_brands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read catalog brands" ON public.catalog_brands;
CREATE POLICY "read catalog brands" ON public.catalog_brands
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admins write catalog brands" ON public.catalog_brands;
CREATE POLICY "admins write catalog brands" ON public.catalog_brands
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- user_catalog_mutes gains a third kind. The CHECK is rebuilt rather than
-- extended because Postgres has no ALTER ... ADD VALUE for a check constraint.
ALTER TABLE public.user_catalog_mutes DROP CONSTRAINT IF EXISTS user_catalog_mutes_kind_check;
ALTER TABLE public.user_catalog_mutes
  ADD CONSTRAINT user_catalog_mutes_kind_check
  CHECK (kind IN ('retailer', 'excluded_term', 'brand'));

-- ---- ATTACHING A SHOP TO A SHARED BRAND --------------------------------
--
-- user_brand_sources.(user_id, brand) had an FK to user_brands. A user can now
-- map a shop onto a brand that exists only in the shared catalogue, which that
-- FK would reject. Dropped for the same reason retailer_id's was: one column
-- cannot reference two tables, and every read path joins the brand anyway.
DO $$
DECLARE v_con text;
BEGIN
  SELECT conname INTO v_con FROM pg_constraint
  WHERE conrelid = 'public.user_brand_sources'::regclass
    AND contype = 'f' AND confrelid = 'public.user_brands'::regclass
  LIMIT 1;
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_brand_sources DROP CONSTRAINT %I', v_con);
    RAISE NOTICE 'dropped FK % so a shop can attach to a shared brand', v_con;
  END IF;
END $$;

-- ---- THE ONE DEFINITION EVERYTHING READS -------------------------------
CREATE OR REPLACE FUNCTION public.get_effective_brands_for(p_user uuid)
RETURNS TABLE(brand text, match_mode text, scope text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ub.brand, COALESCE(ub.match_mode, 'exact'), 'user'
  FROM public.user_brands ub
  WHERE ub.user_id = p_user
    AND COALESCE(ub.status, '') <> 'ignore'
    AND btrim(COALESCE(ub.brand, '')) <> ''
  UNION ALL
  SELECT cb.brand, cb.match_mode, 'catalog'
  FROM public.catalog_brands cb
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_catalog_mutes m
     WHERE m.user_id = p_user AND m.kind = 'brand' AND m.target_id = cb.id
  )
  -- A brand the user already carries wins: their row holds their own
  -- match_mode and their own ignore status, both of which must not be
  -- overridden by the catalogue.
  AND NOT EXISTS (
    SELECT 1 FROM public.user_brands ub2
     WHERE ub2.user_id = p_user
       AND lower(btrim(ub2.brand)) = lower(btrim(cb.brand))
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_effective_brands_for(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_effective_brands_for(uuid) TO service_role;

-- UI variant: the caller's own set, with the extra fields a management list
-- needs (id for muting, the muted flag, stock counts for their own rows).
CREATE OR REPLACE FUNCTION public.get_effective_brands()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_agg(b ORDER BY lower(b ->> 'brand')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'id', NULL, 'brand', ub.brand,
             'match_mode', COALESCE(ub.match_mode, 'exact'),
             'scope', 'user', 'muted', false,
             'asin_count', ub.asin_count, 'status', ub.status
           ) AS b
    FROM public.user_brands ub
    WHERE ub.user_id = auth.uid()
    UNION ALL
    SELECT jsonb_build_object(
             'id', cb.id, 'brand', cb.brand, 'match_mode', cb.match_mode,
             'scope', 'catalog',
             'muted', EXISTS (
               SELECT 1 FROM public.user_catalog_mutes m
                WHERE m.user_id = auth.uid() AND m.kind = 'brand' AND m.target_id = cb.id
             ),
             'asin_count', 0, 'status', NULL
           ) AS b
    FROM public.catalog_brands cb
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_brands ub2
       WHERE ub2.user_id = auth.uid()
         AND lower(btrim(ub2.brand)) = lower(btrim(cb.brand))
    )
  ) t;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_effective_brands() TO authenticated;

DO $$
DECLARE v_admin uuid; v_seeded bigint; v_other uuid; v_eff bigint; v_own bigint;
BEGIN
  SELECT user_id INTO v_admin FROM public.user_roles WHERE role = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE NOTICE 'no admin account found -- catalogue left empty';
    RETURN;
  END IF;

  -- Seed from the admin's own list, which is what "share my brands" means.
  INSERT INTO public.catalog_brands (brand, match_mode)
  SELECT DISTINCT ON (lower(btrim(ub.brand)))
         btrim(ub.brand), COALESCE(ub.match_mode, 'exact')
  FROM public.user_brands ub
  WHERE ub.user_id = v_admin
    AND COALESCE(ub.status, '') <> 'ignore'
    AND btrim(COALESCE(ub.brand, '')) <> ''
  ORDER BY lower(btrim(ub.brand)), ub.asin_count DESC
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_seeded FROM public.catalog_brands;

  SELECT u.id INTO v_other FROM auth.users u
  WHERE u.id IS DISTINCT FROM v_admin
    AND NOT EXISTS (SELECT 1 FROM public.user_roles r
                     WHERE r.user_id = u.id AND r.role = 'admin')
  ORDER BY u.created_at LIMIT 1;

  IF v_other IS NOT NULL THEN
    SELECT count(*) INTO v_own FROM public.user_brands
     WHERE user_id = v_other AND COALESCE(status,'') <> 'ignore';
    SELECT count(*) INTO v_eff FROM public.get_effective_brands_for(v_other);
    RAISE NOTICE 'catalogue seeded with % brands from the admin', v_seeded;
    RAISE NOTICE 'an existing user: % own brands -> % effective (union, no backfill)',
      v_own, v_eff;
  ELSE
    RAISE NOTICE 'catalogue seeded with % brands', v_seeded;
  END IF;
END $$;
