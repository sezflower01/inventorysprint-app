-- Let keepa_seller_name_cache remember a MISS, not just a hit.
--
-- The bug this fixes, measured 2026-11-11: 5,626 of 38,225 cached sellers are
-- re-queried from Keepa on EVERY scan and never resolve. 4,394 of them were
-- first asked about more than a month ago; the oldest dates to 2026-05-02 and
-- is still nameless.
--
-- Cause: resolveSellerNames() decides freshness with
--   `current_rating != null OR current_rating_count != null`
-- which was written so rows predating the rating columns would be re-fetched
-- once to backfill them. A seller Keepa has NO RECORD of is also written with
-- both rating columns NULL, so the two are indistinguishable and the miss is
-- never fresh. There is nowhere in the row to record "we asked, Keepa does not
-- know this seller" -- so it asks again, for ever.
--
-- Two columns give a miss somewhere to live:
--   miss_count       how many times Keepa returned nothing for this seller
--   last_attempt_at  when we last asked, hit or miss
--
-- Backoff is derived from miss_count rather than stored, so there is no second
-- piece of state to keep in step: 1 day, then 3, 7, 30, capped at 30. A seller
-- that genuinely appears in Keepa later still gets picked up within a month,
-- and a seller that never will costs one lookup a month instead of one per
-- scan.
ALTER TABLE public.keepa_seller_name_cache
  ADD COLUMN IF NOT EXISTS miss_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

COMMENT ON COLUMN public.keepa_seller_name_cache.miss_count IS
  'Consecutive times Keepa /seller returned no record for this seller_id. Reset to 0 on a successful name. Drives the retry backoff in resolveSellerNames (1d, 3d, 7d, 30d cap) so a permanently-unknown seller is not re-queried on every scan.';
COMMENT ON COLUMN public.keepa_seller_name_cache.last_attempt_at IS
  'When Keepa /seller was last called for this seller_id, hit or miss. With miss_count this is what makes a MISS cacheable; expires_at only ever described a hit.';

-- Seed the existing misses so the backoff starts working immediately rather
-- than after each one has failed once more. A row with no name has, by
-- definition, already missed at least once.
UPDATE public.keepa_seller_name_cache
   SET miss_count = GREATEST(miss_count, 1),
       last_attempt_at = COALESCE(last_attempt_at, fetched_at)
 WHERE business_name IS NULL
   AND storefront_name IS NULL
   AND miss_count = 0;

-- The lookup is `WHERE seller_id IN (...) AND marketplace = ...` on every
-- scan, against 38k rows.
CREATE INDEX IF NOT EXISTS idx_keepa_seller_name_cache_lookup
  ON public.keepa_seller_name_cache (marketplace, seller_id);

DO $p$
DECLARE v_seeded int; v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM public.keepa_seller_name_cache;
  SELECT count(*) INTO v_seeded FROM public.keepa_seller_name_cache WHERE miss_count > 0;
  RAISE NOTICE 'keepa_seller_name_cache: % rows, % seeded as known misses', v_total, v_seeded;
  RAISE NOTICE 'Those % will now be retried on a 1/3/7/30-day backoff instead', v_seeded;
  RAISE NOTICE 'of on every scan.';
END
$p$;
