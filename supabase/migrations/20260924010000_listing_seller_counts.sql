-- Record how many sellers were on a listing when it was created, so it can be
-- compared with now.
--
-- Seller request 2026-09-24: "when I create the listing I don't know exactly
-- how many sellers... I want to record how many sellers just the numbers and
-- create a button recheck to compare between when I first created and now."
-- Competition at purchase time is the thing you cannot reconstruct later:
-- Amazon keeps no history of it, and by the time a slow seller is reviewed the
-- original offer count is gone.
--
-- Two places, deliberately:
--   * created_listings carries the CREATE-time numbers, so the Created
--     Listings row can show "5 at create -> 9 now" without a join.
--   * listing_seller_counts keeps every check, so the trail between create and
--     today survives (and a second recheck does not overwrite the first).
--
-- Counts come from SP-API getItemOffers (New condition), which is exact and
-- splits FBA from FBM. It shares the 'pricing_api' bucket with the repricer,
-- so it runs ONLY on create and on an explicit Recheck -- never on a timer.

ALTER TABLE public.created_listings
  ADD COLUMN IF NOT EXISTS sellers_at_create      smallint,
  ADD COLUMN IF NOT EXISTS sellers_fba_at_create  smallint,
  ADD COLUMN IF NOT EXISTS sellers_fbm_at_create  smallint,
  ADD COLUMN IF NOT EXISTS sellers_counted_at     timestamptz;

COMMENT ON COLUMN public.created_listings.sellers_at_create IS
  'Number of New offers on the listing when it was created (SP-API getItemOffers). NULL for listings created before 2026-09-24 -- there is no way to backfill it, Amazon keeps no offer-count history.';
COMMENT ON COLUMN public.created_listings.sellers_counted_at IS
  'When sellers_at_create was measured. Normally seconds after the listing was saved; NULL when the count could not be fetched.';

CREATE TABLE IF NOT EXISTS public.listing_seller_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  asin                text NOT NULL,
  marketplace         text NOT NULL DEFAULT 'US',
  created_listing_id  uuid,
  total_offers        smallint NOT NULL,
  fba_offers          smallint,
  fbm_offers          smallint,
  buybox_price        numeric(10,2),
  lowest_price        numeric(10,2),
  -- 'create' = measured as the listing was saved, 'recheck' = the seller
  -- pressed Recheck. Kept apart so the baseline can never be overwritten by a
  -- later check.
  reason              text NOT NULL DEFAULT 'recheck',
  checked_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_seller_counts_reason_chk CHECK (reason IN ('create', 'recheck'))
);

CREATE INDEX IF NOT EXISTS listing_seller_counts_lookup_idx
  ON public.listing_seller_counts (user_id, asin, marketplace, checked_at DESC);
CREATE INDEX IF NOT EXISTS listing_seller_counts_listing_idx
  ON public.listing_seller_counts (created_listing_id, checked_at DESC)
  WHERE created_listing_id IS NOT NULL;

ALTER TABLE public.listing_seller_counts ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  CREATE POLICY "Users read their own seller counts"
    ON public.listing_seller_counts FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $rls$;

DO $rls$
BEGIN
  -- The edge function writes with the service role, but the extension may also
  -- insert directly, so the owner needs INSERT as well.
  CREATE POLICY "Users record their own seller counts"
    ON public.listing_seller_counts FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $rls$;

COMMENT ON TABLE public.listing_seller_counts IS
  'Every seller/offer count taken for a listing: one row at create time, one per Recheck. Written by the listing-seller-count edge function from SP-API getItemOffers. Append-only by convention -- the create row is the baseline a comparison needs.';
