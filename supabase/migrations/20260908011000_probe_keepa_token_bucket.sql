-- PROBE (read-only): read the actual Keepa token bucket.
--
-- The table was created with refill_per_min = 5 and bucket_max = 300, matching
-- the plan as understood on 2026-08-15. CLAUDE.md records that the plan was
-- later measured at 25 tokens/min (5 Pro + 20 API) and KEEPA_GUARD_LIMIT was
-- raised from 4 to 20 to match.
--
-- The code constant and the DATABASE row are two different things. If
-- refill_per_min is still 5, the app is rate-limiting itself to a fifth of the
-- capacity actually being paid for, and every "budget busy" message the seller
-- sees is self-inflicted. Read it rather than assume it.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== the live token bucket ========';
  FOR r IN
    SELECT tokens_left, refill_per_min, bucket_max, denied_count,
           last_denied_at, last_observed_at, updated_at,
           LEAST(bucket_max,
             tokens_left + (EXTRACT(EPOCH FROM (now() - updated_at)) / 60.0) * refill_per_min
           ) AS projected_now
    FROM public.keepa_token_budget WHERE id
  LOOP
    RAISE NOTICE '   tokens_left      : %', round(r.tokens_left, 2);
    RAISE NOTICE '   projected now    : %', round(r.projected_now, 2);
    RAISE NOTICE '   refill_per_min   : %   <- plan is 25/min per CLAUDE.md', r.refill_per_min;
    RAISE NOTICE '   bucket_max       : %', r.bucket_max;
    RAISE NOTICE '   denied_count     : %', r.denied_count;
    RAISE NOTICE '   last_denied_at   : %', r.last_denied_at;
    RAISE NOTICE '   last_observed_at : %  <- last time Keepa told us the truth', r.last_observed_at;
    RAISE NOTICE '   updated_at       : %', r.updated_at;

    IF r.refill_per_min < 25 THEN
      RAISE NOTICE '';
      RAISE NOTICE '   *** refill_per_min is %, the plan refills 25/min ***', r.refill_per_min;
      RAISE NOTICE '   *** the app is throttling itself to %%% of paid capacity ***',
        round(r.refill_per_min / 25.0 * 100);
      RAISE NOTICE '   a 5-token panel view needs % seconds of refill at this rate,',
        round(5.0 / r.refill_per_min * 60, 1);
      RAISE NOTICE '   against % seconds at the real plan rate', round(5.0 / 25.0 * 60, 1);
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is anything reconciling against Keepa reported balance? ========';
  FOR r IN
    SELECT last_observed_at,
           CASE WHEN last_observed_at IS NULL THEN 'NEVER'
                ELSE (EXTRACT(EPOCH FROM (now() - last_observed_at))/3600)::int || ' hours ago'
           END AS age
    FROM public.keepa_token_budget WHERE id
  LOOP
    RAISE NOTICE '   last reconciled: %', r.age;
    RAISE NOTICE '   (reportKeepaTokensLeft overwrites our estimate with Keepa own figure;';
    RAISE NOTICE '    if this is NEVER or stale, the bucket is running on estimates alone)';
  END LOOP;
END
$probe$;
