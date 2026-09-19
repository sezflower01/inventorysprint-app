-- READ-ONLY PROBE. Creates nothing permanent, changes nothing.
-- Context for the VA fix list:
--  (1) the 24 "inactive" listings were almost all first flagged 2026-08-20/21:
--      is that when detection started, or a real one-day event on Amazon?
--      And are they FBA or FBM?
--  (2) the "repricer off" rows are mostly dead SKUs. For those 6 ASINs, which
--      inventory SKU actually holds the stock, and is THAT SKU repriced?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT min(listing_inactive_detected_at) AS first_ever, count(*) AS n_flagged,
                  count(*) FILTER (WHERE listing_inactive_detected_at::date IN ('2026-08-20','2026-08-21')) AS n_0820
           FROM public.repricer_assignments WHERE user_id = v_uid AND listing_inactive_detected_at IS NOT NULL LOOP
    RAISE NOTICE 'inactive detection: first ever % | flagged ever % | first flagged on 08-20/21 %', r.first_ever, r.n_flagged, r.n_0820;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT a.asin, a.sku, a.fulfillment_type, i.units, i.unfulfilled, i.amazon_price, i.min_price, i.last_price_update_status
           FROM public.repricer_assignments a LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
           WHERE a.user_id = v_uid AND a.marketplace = 'US' AND a.is_enabled AND a.status = 'active' AND a.is_listing_inactive_not_buyable
             AND a.asin IN ('1594712832','B001JLELCC','B003Y8YB1Y','B009Z23AJ2','B00AEBB9V4','B00GFQWY8O','B00QXDKQP2','B01540ONCG',
                            'B01B133CYA','B01BPX8BLK','B01M11DBSR','B06W5VR3ZF','B07HM6CQYB','B07Q1GCDTY','B0979H4K7C','B09RLV3CYF',
                            'B0BCL1G8CJ','B0BD76CTHT','B0DDCVFQZF','B0DNX24QG7','B0FS8378QJ','B0FTKRVYHS','B0GN43VBL1','B0GXCDB8XM')
           ORDER BY a.fulfillment_type, a.asin LOOP
    RAISE NOTICE 'HID|%|%|%|units %|unfulfilled %|amazon_price %|last price push %', r.asin, r.sku, r.fulfillment_type, r.units, r.unfulfilled, r.amazon_price, r.last_price_update_status;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT i.asin, i.sku, i.available, i.reserved, i.inbound, i.listing_status, to_char(i.last_inventory_sync_at, 'MM-DD HH24:MI') AS sync,
                  (SELECT string_agg(format('%s/%s/enabled=%s/rule=%s', a.marketplace, a.status, a.is_enabled, COALESCE(ru.name,'none')), '; ')
                   FROM public.repricer_assignments a LEFT JOIN public.repricer_rules ru ON ru.id = a.rule_id
                   WHERE a.user_id = v_uid AND a.sku = i.sku) AS assign
           FROM public.inventory i
           WHERE i.user_id = v_uid AND i.asin IN ('B0000936JK','B001V5PHP6','B00FAIUBKG','B00GFRIRHU','B01BPX8BLK','B07BP8GNQB')
             AND (COALESCE(i.available,0) + COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) > 0
           ORDER BY i.asin, i.available DESC NULLS LAST LOOP
    RAISE NOTICE 'OFFSTOCK|%|%|avail %|res %|inb %|%|sync %|assignments: %', r.asin, r.sku, r.available, r.reserved, r.inbound, r.listing_status, r.sync, COALESCE(r.assign, 'NOT IN REPRICER');
  END LOOP;
END
$p$;
