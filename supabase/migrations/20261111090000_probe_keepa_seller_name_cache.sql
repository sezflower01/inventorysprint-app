-- Why do two FBA competitors show a raw seller ID, and why is the panel slow?
-- READ ONLY.
--
-- Reading resolveSellerNames() in mobile-scan-price-history suggests a loop,
-- and a loop is worth proving rather than asserting:
--
--   * A seller Keepa has no record of is written to keepa_seller_name_cache
--     with business_name NULL, storefront_name NULL and BOTH rating columns
--     NULL, on a 7-day TTL (index.ts:408).
--   * But the freshness test is `current_rating != null OR
--     current_rating_count != null` (index.ts:344). That was added so rows
--     written before the rating feature existed would be re-fetched once to
--     backfill. A Keepa miss has both columns NULL for a different reason --
--     Keepa has nothing -- and is therefore ALSO never counted as fresh.
--   * So it lands in `missing` on every single scan, is re-queried every
--     time, never resolves, and the TTL never gets a chance to matter.
--
-- If that is right the cache will hold rows that are old, nameless, and still
-- being asked about. Count them: each one is a permanent round trip on every
-- panel open, and the /seller call is ungated and unreported (the only
-- reportKeepaTokensLeft in the file is at :783, in the /product path), so it
-- spends from the shared Keepa bucket invisibly.
DO $p$
DECLARE r record; v_tot int; v_null int; v_norate int;
BEGIN
  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. THE TWO SELLERS SHOWING AS RAW IDs ########';
  FOR r IN
    SELECT to_jsonb(c) AS j FROM public.keepa_seller_name_cache c
    WHERE c.seller_id IN ('A3HRO6X2J3TLPL', 'A25DCTNZ99FSTC')
  LOOP
    RAISE NOTICE '   % | mk % | business % | storefront % | rating % / %',
      r.j->>'seller_id', COALESCE(r.j->>'marketplace','-'),
      COALESCE(r.j->>'business_name','NULL'),
      COALESCE(r.j->>'storefront_name','NULL'),
      COALESCE(r.j->>'current_rating','NULL'),
      COALESCE(r.j->>'current_rating_count','NULL');
    RAISE NOTICE '      fetched % | expires %',
      left(COALESCE(r.j->>'fetched_at','-'),19), left(COALESCE(r.j->>'expires_at','-'),19);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NOT CACHED AT ALL -- so every scan queries Keepa for them';
    RAISE NOTICE '   and nothing is written back, which is the same loop by';
    RAISE NOTICE '   another route.';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. HOW BIG IS THE RE-QUERY SET? ########';
  SELECT count(*) INTO v_tot FROM public.keepa_seller_name_cache;
  SELECT count(*) INTO v_null FROM public.keepa_seller_name_cache
   WHERE business_name IS NULL AND storefront_name IS NULL;
  SELECT count(*) INTO v_norate FROM public.keepa_seller_name_cache
   WHERE current_rating IS NULL AND current_rating_count IS NULL;
  RAISE NOTICE '   cached sellers total              : %', v_tot;
  RAISE NOTICE '   ... with NO name at all           : %', v_null;
  RAISE NOTICE '   ... with NO rating data           : %   <-- never "fresh"', v_norate;
  RAISE NOTICE '';
  RAISE NOTICE '   Every row in that last count is re-fetched from Keepa on';
  RAISE NOTICE '   EVERY scan that includes it, regardless of its TTL.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. ARE THEY OLD? (a miss that never heals) ########';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE fetched_at < now() - interval '7 days')::int AS wk,
      count(*) FILTER (WHERE fetched_at < now() - interval '30 days')::int AS mo,
      min(fetched_at)::date AS oldest
    FROM public.keepa_seller_name_cache
    WHERE current_rating IS NULL AND current_rating_count IS NULL
  LOOP
    RAISE NOTICE '   nameless/ratingless rows older than 7 days : %', r.wk;
    RAISE NOTICE '   ... older than 30 days                     : %', r.mo;
    RAISE NOTICE '   oldest such row                            : %', r.oldest;
    IF r.mo > 0 THEN
      RAISE NOTICE '';
      RAISE NOTICE '   >>> CONFIRMED. Rows first queried over a month ago are';
      RAISE NOTICE '   >>> still nameless, so the re-fetch runs and keeps';
      RAISE NOTICE '   >>> failing. It is a permanent cost, not a warm-up.';
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. A FEW OF THEM ########';
  FOR r IN
    SELECT seller_id, COALESCE(marketplace,'-') AS mk, fetched_at::date AS d
    FROM public.keepa_seller_name_cache
    WHERE current_rating IS NULL AND current_rating_count IS NULL
    ORDER BY fetched_at LIMIT 10
  LOOP
    RAISE NOTICE '   % | % | first seen %', rpad(r.seller_id,16), rpad(r.mk,4), r.d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
