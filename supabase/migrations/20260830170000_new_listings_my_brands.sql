-- Mark seller-watch new listings that fall in a brand the user already carries.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Asked 2026-08-30: restrict the Seller Analyzer's new-listings view to brands
-- already carried, so sourcing expands a known catalogue rather than starting
-- cold on every detection. 1,484 brands have been bought at some point but only
-- 205 hold stock and 66 hold 10+ units -- so "brands I know" is a far better
-- filter than "everything a watched seller listed".
--
-- Deliberately matches against ALL of user_brands, not just brands currently in
-- stock. 1,279 of those 1,484 sit at zero units, and those are precisely the
-- ones the user said they intend to restock: a brand bought once and sold
-- through is a known quantity, not a stranger.
--
-- ── WHY A VIEW ────────────────────────────────────────────────────────────
--
-- The alternative was fetching the user's brand list into the browser and
-- passing it to PostgREST as `.in("brand", [...])`. With 1,484 brand names that
-- is roughly 20KB of URL, past what proxies reliably accept, and it would fail
-- by silently truncating rather than erroring. Matching in the database has no
-- such ceiling.
--
-- security_invoker = true so the underlying RLS still applies as the calling
-- user. Without it the view would run as its owner and expose every account's
-- listings -- the classic way a view launders RLS away.
--
-- ── CASE-INSENSITIVE ON PURPOSE ───────────────────────────────────────────
--
-- inventory.brand comes from SP-API getCatalogItem; seller_watch_new_listings.brand
-- comes from the seller-watch path. Same brand, two sources, no guarantee of
-- identical casing or padding -- and an exact match would quietly report "not
-- my brand" for things that plainly are.

-- Supports the join. lower(trim(...)) must match the view's expression exactly
-- or the planner will not use it.
CREATE INDEX IF NOT EXISTS idx_user_brands_lookup
  ON public.user_brands (user_id, lower(trim(brand)));

CREATE OR REPLACE VIEW public.seller_new_listings_branded
WITH (security_invoker = true) AS
SELECT
  l.*,
  (b.brand IS NOT NULL) AS is_my_brand,
  -- Carried through so the UI can say WHY a listing matched, and show how much
  -- of that brand is already held. A match on a brand sitting at 300 units is a
  -- different signal from one last bought a year ago.
  b.unit_count  AS my_brand_units,
  b.asin_count  AS my_brand_asins
FROM public.seller_watch_new_listings l
LEFT JOIN public.user_brands b
  ON  b.user_id = l.user_id
  AND lower(trim(b.brand)) = lower(trim(l.brand));

COMMENT ON VIEW public.seller_new_listings_branded IS
  'seller_watch_new_listings plus is_my_brand / my_brand_units / my_brand_asins, matched case-insensitively against user_brands. security_invoker so RLS still applies to the caller.';

GRANT SELECT ON public.seller_new_listings_branded TO authenticated;

DO $$
DECLARE
  v_total    bigint;
  v_branded  bigint;
  v_mine     bigint;
BEGIN
  SELECT count(*), count(brand) INTO v_total, v_branded
  FROM public.seller_watch_new_listings;

  SELECT count(*) INTO v_mine
  FROM public.seller_new_listings_branded WHERE is_my_brand;

  RAISE NOTICE 'seller_new_listings_branded ready.';
  -- Stated up front because the filter is only as good as this coverage: if
  -- most detections carry no brand at all, "my brands only" hides nearly
  -- everything and looks broken rather than selective.
  RAISE NOTICE '% listing(s) total, % with a brand recorded, % matching a brand already carried.',
    v_total, v_branded, v_mine;
END $$;
