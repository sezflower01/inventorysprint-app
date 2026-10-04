-- Record how many sellers were on a listing WHEN A PURCHASE WAS ADDED.
--
-- 'create' already captures the baseline at listing creation, because Amazon
-- keeps no offer-count history and "how many sellers were on it when I bought"
-- cannot be recovered after the fact. The same is true of every REORDER, and
-- that is the decision this seller actually repeats: a listing created in 2025
-- with 3 sellers may have 13 by the time the second purchase is placed, and
-- nothing recorded the number at the moment that money was committed.
--
-- 'purchase' therefore joins the set, kept distinct from 'recheck' so that
-- "sellers at my last purchase" is answerable without guessing which of a
-- hundred manual rechecks happened to sit next to a buy.

ALTER TABLE public.listing_seller_counts
  DROP CONSTRAINT IF EXISTS listing_seller_counts_reason_chk;

ALTER TABLE public.listing_seller_counts
  ADD CONSTRAINT listing_seller_counts_reason_chk
  CHECK (reason IN ('create', 'recheck', 'purchase'));

COMMENT ON COLUMN public.listing_seller_counts.reason IS
  'create = measured as the listing was saved (the baseline, written once); purchase = measured as a purchase batch was added, so competition at the moment of each buy is on the record; recheck = the seller pressed Recheck. Kept apart so neither the baseline nor a purchase can be overwritten by a later manual check.';

-- A purchase row is looked up by "the most recent purchase for this ASIN", so
-- give that query its own index rather than making it scan every recheck.
CREATE INDEX IF NOT EXISTS listing_seller_counts_purchase_idx
  ON public.listing_seller_counts (user_id, asin, marketplace, checked_at DESC)
  WHERE reason = 'purchase';

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT reason, count(*) AS rows, max(checked_at) AS newest
           FROM public.listing_seller_counts GROUP BY reason ORDER BY 2 DESC LOOP
    RAISE NOTICE 'existing rows: % = % (newest %)', r.reason, r.rows, r.newest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE 'no seller-count rows yet'; END IF;
END
$p$;
