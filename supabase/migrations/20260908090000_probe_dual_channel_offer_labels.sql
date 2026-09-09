-- PROBE (read-only): confirm the analyser regression is what it looks like, and
-- that the new guard resolves it, before deploying.
--
-- The extension listed two "YOU" offers on B0G2YNN87D at $37.74 and labelled
-- BOTH FBM. One of them is 60 units of real FBA stock.
--
-- The override in mobile-scan-price-history is ASIN-level:
--     isFBA = IsFulfilledByAmazon && !(isSelf && hasLiveFbmInventory)
-- so ANY FBM row with stock on the ASIN forces EVERY self-offer to FBM. Before
-- today this ASIN had no amazon_sync_fbm row, so the flag was false and both
-- offers were labelled by Amazon's own per-offer field. Retyping the FBM row
-- flipped it true -- meaning the fix earlier today is what surfaced this.
--
-- The new guard only applies the override when the ASIN is single-channel FBM.
-- Check which ASINs are now dual-channel, i.e. which ones change behaviour.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== B0G2YNN87D: what the two flags evaluate to ========';
  FOR r IN
    SELECT
      bool_or(source = 'amazon_sync_fbm'
              AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0)) AS has_live_fbm,
      bool_or((fnsku IS NOT NULL OR COALESCE(reserved,0) + COALESCE(inbound,0) > 0)
              AND NOT (source = 'amazon_sync_fbm'
                       AND COALESCE(reserved,0) + COALESCE(inbound,0) = 0)
              AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0
                   OR COALESCE(inbound,0) > 0)) AS has_live_fba
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B0G2YNN87D'
  LOOP
    RAISE NOTICE '   hasLiveFbmInventory = %', r.has_live_fbm;
    RAISE NOTICE '   hasLiveFbaInventory = %  <- new', r.has_live_fba;
    RAISE NOTICE '   singleChannelFbm    = %  (override applies only when true)',
      r.has_live_fbm AND NOT r.has_live_fba;
    IF r.has_live_fbm AND r.has_live_fba THEN
      RAISE NOTICE '   -> dual channel: Amazon per-offer IsFulfilledByAmazon is trusted';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== every ASIN where the override behaviour CHANGES ========';
  -- Only dual-channel ASINs are affected. Single-channel FBM keeps the old
  -- forced-FBM behaviour exactly, which is the case the override was added for.
  FOR r IN
    SELECT asin,
      bool_or(source = 'amazon_sync_fbm'
              AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0)) AS fbm,
      bool_or((fnsku IS NOT NULL OR COALESCE(reserved,0) + COALESCE(inbound,0) > 0)
              AND NOT (source = 'amazon_sync_fbm'
                       AND COALESCE(reserved,0) + COALESCE(inbound,0) = 0)
              AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0
                   OR COALESCE(inbound,0) > 0)) AS fba
    FROM public.inventory WHERE user_id = v_uid
    GROUP BY asin
    HAVING bool_or(source = 'amazon_sync_fbm'
                   AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0))
       AND bool_or((fnsku IS NOT NULL OR COALESCE(reserved,0) + COALESCE(inbound,0) > 0)
                   AND NOT (source = 'amazon_sync_fbm'
                            AND COALESCE(reserved,0) + COALESCE(inbound,0) = 0)
                   AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0
                        OR COALESCE(inbound,0) > 0))
    ORDER BY asin
  LOOP
    RAISE NOTICE '   %  (fbm=% fba=%)', r.asin, r.fbm, r.fba;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many ASINs keep the OLD forced-FBM behaviour? ========';
  FOR r IN
    SELECT count(*) AS n FROM (
      SELECT asin FROM public.inventory WHERE user_id = v_uid GROUP BY asin
      HAVING bool_or(source = 'amazon_sync_fbm'
                     AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0))
         AND NOT bool_or((fnsku IS NOT NULL OR COALESCE(reserved,0) + COALESCE(inbound,0) > 0)
                     AND NOT (source = 'amazon_sync_fbm'
                              AND COALESCE(reserved,0) + COALESCE(inbound,0) = 0)
                     AND (COALESCE(available,0) > 0 OR COALESCE(reserved,0) > 0
                          OR COALESCE(inbound,0) > 0))
    ) x
  LOOP
    RAISE NOTICE '   % single-channel FBM ASINs -- unchanged, still forced FBM', r.n;
  END LOOP;
END
$probe$;
