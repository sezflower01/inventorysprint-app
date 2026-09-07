-- PROBE (read-only): B001GQ2DB6 was converted FBA -> FBM but still displays FBA.
--
-- This is a consequence of the detectIsFba change made earlier today. That fix
-- was for the opposite failure -- 327 genuinely-FBA listings were showing FBM
-- because the source string "live_api" matched neither "fba" nor
-- "amazon_sync" -- and it made an FNSKU decisive proof of FBA.
--
-- An FNSKU does not vanish when a seller converts a listing to merchant
-- fulfilment. Amazon issues it against the FBA offer, and it stays on the
-- inventory record. So "has FNSKU therefore FBA" is true for a listing that
-- was NEVER FBA-converted, and wrong for one that has been.
--
-- The question is which live signals distinguish a converted listing, so the
-- rule can use them instead of guessing.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== the converted listing ========';
  FOR r IN
    SELECT i.sku, i.asin, i.fnsku, i.source, i.listing_status,
           i.available, i.reserved, i.inbound, i.unfulfilled,
           i.my_price, i.units,
           to_char(i.last_inventory_sync_at AT TIME ZONE 'America/Chicago','MM-DD HH24:MI') AS last_sync,
           to_char(i.updated_at AT TIME ZONE 'America/Chicago','MM-DD HH24:MI') AS updated
    FROM public.inventory i
    WHERE i.user_id = v_uid AND i.asin = 'B001GQ2DB6'
  LOOP
    RAISE NOTICE '   sku=% fnsku=% source=% status=%',
      r.sku, COALESCE(r.fnsku,'(none)'), r.source, r.listing_status;
    RAISE NOTICE '   avail=% reserved=% inbound=% unfulfilled=% units=% price=%',
      r.available, r.reserved, r.inbound, r.unfulfilled, r.units, r.my_price;
    RAISE NOTICE '   last inventory sync % | updated %', r.last_sync, r.updated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what the assignment thinks ========';
  FOR r IN
    SELECT sku, marketplace, fulfillment_type, is_enabled,
           to_char(updated_at AT TIME ZONE 'America/Chicago','MM-DD HH24:MI') AS updated
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND asin = 'B001GQ2DB6'
  LOOP
    RAISE NOTICE '   % | % | stored fulfillment_type=% | enabled=% | updated %',
      r.sku, r.marketplace, COALESCE(r.fulfillment_type,'(null)'), r.is_enabled, r.updated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== does any signal distinguish converted listings? ========';
  -- If unfulfilled>0 with no FBA stock is characteristic of merchant offers,
  -- that is a usable discriminator. Check how it distributes.
  FOR r IN
    SELECT
      count(*) FILTER (WHERE fnsku IS NOT NULL AND btrim(fnsku) <> '') AS with_fnsku,
      count(*) FILTER (WHERE fnsku IS NOT NULL AND btrim(fnsku) <> ''
                         AND COALESCE(unfulfilled,0) > 0) AS fnsku_and_unfulfilled,
      count(*) FILTER (WHERE fnsku IS NOT NULL AND btrim(fnsku) <> ''
                         AND COALESCE(reserved,0)+COALESCE(inbound,0) = 0
                         AND COALESCE(unfulfilled,0) > 0) AS fnsku_no_fba_stock_but_unfulfilled,
      count(*) FILTER (WHERE lower(COALESCE(source,'')) = 'amazon_sync_fbm') AS src_fbm,
      count(*) AS total
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % inventory rows | % have an FNSKU', r.total, r.with_fnsku;
    RAISE NOTICE '   % have FNSKU AND unfulfilled>0', r.fnsku_and_unfulfilled;
    RAISE NOTICE '   % have FNSKU, no reserved/inbound, but unfulfilled>0', r.fnsku_no_fba_stock_but_unfulfilled;
    RAISE NOTICE '   % carry source amazon_sync_fbm', r.src_fbm;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== other rows that look converted the same way ========';
  n := 0;
  FOR r IN
    SELECT sku, asin, source, listing_status,
           available, reserved, inbound, unfulfilled,
           CASE WHEN fnsku IS NOT NULL AND btrim(fnsku) <> '' THEN 'yes' ELSE 'no' END AS has_fnsku
    FROM public.inventory
    WHERE user_id = v_uid
      AND fnsku IS NOT NULL AND btrim(fnsku) <> ''
      AND COALESCE(reserved,0) + COALESCE(inbound,0) = 0
      AND COALESCE(unfulfilled,0) > 0
    ORDER BY unfulfilled DESC LIMIT 12
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | % | src=% | %/%/% unf=% | fnsku=%',
      r.asin, left(r.sku,20), r.source, r.available, r.reserved, r.inbound, r.unfulfilled, r.has_fnsku;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none match that shape)'; END IF;
END
$probe$;
