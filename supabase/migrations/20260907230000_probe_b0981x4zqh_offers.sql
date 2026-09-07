-- PROBE (read-only): is B0981X4ZQH chasing a real competitor, or its own offer?
--
-- The panel reports Buy Box $28.10, Lowest FBA $28.10, Lowest Overall $28.10,
-- "Am I Lowest? Raw and Filtered both yes", seller at $28.07. Yet the action
-- that produced that price says:
--
--   "Price lowered from $28.10 to $28.07 to match the lowest competitor
--    price ($28.07)"
--
-- No competitor is at $28.07 in any figure on that panel. The only offer ever
-- at $28.07 is the seller's own, from before the preceding raise. offers_json
-- carries the actual offer list, so it can be checked rather than inferred.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== snapshots for B0981X4ZQH ========';
  n := 0;
  FOR r IN
    SELECT to_char(created_at AT TIME ZONE 'America/Chicago','HH24:MI:SS') AS t,
           buybox_price, lowest_fba_price, lowest_fbm_price, lowest_overall_price,
           offers_count, COALESCE(buybox_seller_name, buybox_seller_id, '-') AS bb_seller,
           buybox_is_fba, source
    FROM public.repricer_competitor_snapshots
    WHERE user_id = v_uid AND asin = 'B0981X4ZQH' AND marketplace = 'US'
    ORDER BY created_at DESC LIMIT 6
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | bb=% fba=% fbm=% overall=% | % offers | bb=% (fba=%) | src=%',
      r.t, r.buybox_price, r.lowest_fba_price, r.lowest_fbm_price,
      r.lowest_overall_price, r.offers_count, left(r.bb_seller,18), r.buybox_is_fba, r.source;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no snapshots stored)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== the offers themselves, newest snapshot ========';
  n := 0;
  FOR r IN
    SELECT o->>'sellerId'        AS seller,
           o->>'sellerName'      AS seller_name,
           o->>'price'           AS price,
           o->>'listingPrice'    AS listing_price,
           o->>'isFulfilledByAmazon' AS fba,
           o->>'isBuyBoxWinner'  AS is_bb,
           o->>'isMyOffer'       AS is_mine
    FROM public.repricer_competitor_snapshots s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.offers_json) = 'array' THEN s.offers_json ELSE '[]'::jsonb END
    ) o
    WHERE s.user_id = v_uid AND s.asin = 'B0981X4ZQH' AND s.marketplace = 'US'
      AND s.created_at = (SELECT max(created_at) FROM public.repricer_competitor_snapshots
                           WHERE user_id = v_uid AND asin = 'B0981X4ZQH' AND marketplace = 'US')
  LOOP
    n := n + 1;
    RAISE NOTICE '   seller=%-16s price=% listing=% fba=% bb=% mine=% | %',
      left(COALESCE(r.seller,'-'),16), COALESCE(r.price,'-'), COALESCE(r.listing_price,'-'),
      COALESCE(r.fba,'-'), COALESCE(r.is_bb,'-'), COALESCE(r.is_mine,'-'),
      left(COALESCE(r.seller_name,''),22);
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (offers_json empty or not an array)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== the seller own inventory row ========';
  FOR r IN
    SELECT i.sku, i.my_price, i.price, i.listing_status, i.available, i.reserved, i.inbound
    FROM public.inventory i
    WHERE i.user_id = v_uid AND i.asin = 'B0981X4ZQH'
  LOOP
    RAISE NOTICE '   sku=% my_price=% price=% status=% stock %/%/%',
      r.sku, r.my_price, r.price, r.listing_status, r.available, r.reserved, r.inbound;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== assignment floor and oscillation state ========';
  FOR r IN
    SELECT min_price_override, max_price_override, last_applied_price,
           last_buybox_price, last_buybox_status, oscillation_state
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND asin = 'B0981X4ZQH' AND marketplace = 'US'
  LOOP
    RAISE NOTICE '   min=% max=% last_applied=% last_bb=% bb_status=% osc=%',
      r.min_price_override, r.max_price_override, r.last_applied_price,
      r.last_buybox_price, r.last_buybox_status, r.oscillation_state;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== price changes today ========';
  n := 0;
  FOR r IN
    SELECT to_char(created_at AT TIME ZONE 'America/Chicago','HH24:MI:SS') AS t,
           old_price, new_price, left(COALESCE(reason,''), 88) AS reason
    FROM public.repricer_price_actions
    WHERE user_id = v_uid AND asin = 'B0981X4ZQH' AND marketplace = 'US'
      AND created_at > now() - interval '10 hours'
      AND old_price IS DISTINCT FROM new_price AND new_price IS NOT NULL
    ORDER BY created_at DESC LIMIT 16
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | % -> % | %', r.t, r.old_price, r.new_price, r.reason;
  END LOOP;
  RAISE NOTICE '   % price changes in 10 hours', n;
END
$probe$;
