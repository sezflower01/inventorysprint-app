-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller asks whether this was the right call on B0BXKSYPYY/US:
--   10:50:37 lowered 33.95 -> 33.94 "to match the lowest FBA competitor"
--   10:54:09 raised  33.94 -> 34.11 "eligible-gap recovery: next eligible 35.95"
-- Those two are only consistent if the 33.94 offer at 10:54 was OUR OWN (we
-- had just matched it), leaving 35.95 as the next real competitor. If 33.94
-- was a DIFFERENT seller, the raise walked away from the Buy Box while the
-- panel still read "Not Owner" and "Am I lowest: No".
-- Look at the decisions, the price actions and the competitor snapshots.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== assignment state now ==';
  FOR r IN SELECT sku, last_applied_price, min_price_override, max_price_override, last_buybox_status, last_buybox_price,
                  to_char(last_sp_api_check_at, 'HH24:MI:SS') AS checked, to_char(last_price_change_at, 'HH24:MI:SS') AS changed,
                  last_recommended_price, last_skip_reason, detected_offer_seller_id, detected_offer_price
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B0BXKSYPYY' AND marketplace = 'US' LOOP
    RAISE NOTICE '  sku % | applied % | min % max % | BB % @ % | checked % | changed % | rec % | skip % | my offer % @ %',
      r.sku, r.last_applied_price, r.min_price_override, r.max_price_override, r.last_buybox_status, r.last_buybox_price,
      r.checked, r.changed, r.last_recommended_price, COALESCE(r.last_skip_reason,'-'), r.detected_offer_seller_id, r.detected_offer_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== competitor snapshots around the two actions ==';
  FOR r IN SELECT to_char(fetched_at, 'HH24:MI:SS') AS at, buybox_price, buybox_seller_id, lowest_fba_price, lowest_overall_price,
                  offers_count, buybox_is_fba, buybox_seller_name, lowest_fbm_price
           FROM public.repricer_competitor_snapshots
           WHERE user_id = v_uid AND asin = 'B0BXKSYPYY' AND marketplace = 'US'
             AND fetched_at > now() - interval '12 hours'
           ORDER BY fetched_at DESC LIMIT 12 LOOP
    RAISE NOTICE '  % | BB % (% / %) fba=% | lowest FBA % | lowest FBM % | lowest overall % | % offers',
      r.at, r.buybox_price, COALESCE(r.buybox_seller_name, '?'), COALESCE(r.buybox_seller_id, '?'), r.buybox_is_fba,
      r.lowest_fba_price, r.lowest_fbm_price, r.lowest_overall_price, r.offers_count;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== who was actually on the listing at the raise (offers_json) ==';
  FOR r IN SELECT to_char(s.fetched_at, 'HH24:MI:SS') AS at,
                  o->>'sellerId' AS seller, o->>'price' AS price, o->>'fulfillment' AS fulfil,
                  o->>'isBuyBoxWinner' AS bb, o->>'isMine' AS mine, o->>'condition' AS cond
           FROM public.repricer_competitor_snapshots s
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.offers_json) = 'array' THEN s.offers_json ELSE '[]'::jsonb END) o
           WHERE s.user_id = v_uid AND s.asin = 'B0BXKSYPYY' AND s.marketplace = 'US'
             AND s.fetched_at BETWEEN '2026-09-20 10:40:00+00' AND '2026-09-20 11:10:00+00'
           ORDER BY s.fetched_at DESC, (o->>'price')::numeric NULLS LAST LIMIT 20 LOOP
    RAISE NOTICE '  % | % @ % | % | bb=% mine=% %', r.at, r.seller, r.price, r.fulfil, r.bb, r.mine, r.cond;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== decisions today ==';
  FOR r IN SELECT to_char(created_at, 'HH24:MI:SS') AS at, current_price, new_price, buybox_price, buybox_seller_type,
                  lowest_fba_price, lowest_fbm_price, lowest_overall_price, offers_count, is_only_seller, is_buybox_suppressed,
                  apply_status, left(reason, 130) AS reason
           FROM public.repricer_ai_decisions
           WHERE user_id = v_uid AND asin = 'B0BXKSYPYY' AND marketplace = 'US' AND created_at > now() - interval '12 hours'
           ORDER BY created_at DESC LIMIT 14 LOOP
    RAISE NOTICE '  % | % -> % | BB % (%) | FBA % FBM % overall % | % offers | only_seller % suppressed % | % | %',
      r.at, r.current_price, r.new_price, r.buybox_price, r.buybox_seller_type, r.lowest_fba_price, r.lowest_fbm_price,
      r.lowest_overall_price, r.offers_count, r.is_only_seller, r.is_buybox_suppressed, r.apply_status, r.reason;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how often does eligible-gap recovery fire, and does the Buy Box follow? ==';
  FOR r IN SELECT count(*) AS raises, count(DISTINCT d.asin) AS asins, min(d.created_at) AS first, max(d.created_at) AS last
           FROM public.repricer_ai_decisions d
           WHERE d.user_id = v_uid AND d.created_at > now() - interval '7 days'
             AND d.reason ILIKE '%eligible%gap%' LOOP
    RAISE NOTICE '  % raises over % ASINs (% .. %)', r.raises, r.asins, r.first, r.last;
  END LOOP;
END
$p$;
