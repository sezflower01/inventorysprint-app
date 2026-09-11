-- PROBE (read-only): B0G4B3117X -- reconstruct what actually ARRIVED at Amazon,
-- because the purchase ledger cannot be right.
--
-- The contradiction that blocks the cost repair:
--   purchases recorded    1,254 units (954 at 14.56-15.89, 300 at 7.75)
--   clean units sold      1,245
--   should remain              9
--   actually on hand         314   (294 available + 17 reserved + 3 unfulfilled)
--
-- So roughly 305 units were bought and never entered. FIFO -- which decides
-- which sales consumed the 7.75 stock -- depends entirely on WHEN those units
-- arrived:
--   before the 7.75 lots (dated 2026-05-24/25): every past sale used expensive
--     stock, the 300 cheap units are still on the shelf, past COGS change ~0.
--   after them: the cheap units sold Jul 24 - Sep, past COGS change -1,983.
--
-- Rewriting 278 orders' booked cost on a guess about unrecorded purchases would
-- be worse than leaving them. Amazon's own receiving records are independent of
-- the purchase ledger, so read those.
--
-- Three independent timelines: shipment items (shipped vs received), inbound
-- placement fees (posted when units are received), and inventory age.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
  v_shipped bigint := 0; v_received bigint := 0; v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== FBA shipments containing this ASIN ========';
  FOR r IN
    SELECT i.shipment_id, s.shipment_name, s.shipment_status,
           s.created_at::date AS shipment_created, s.confirmed_need_by_date,
           i.quantity_shipped, i.quantity_received, i.quantity_in_case,
           i.created_at::date AS item_created, i.updated_at::date AS item_updated
    FROM public.fba_shipment_items i
    LEFT JOIN public.fba_shipments s
      ON s.user_id = i.user_id AND s.shipment_id = i.shipment_id
    WHERE i.user_id = v_uid AND (i.asin = v_asin OR i.seller_sku = v_sku)
    ORDER BY s.created_at NULLS LAST, i.created_at
  LOOP
    v_n := v_n + 1;
    v_shipped := v_shipped + COALESCE(r.quantity_shipped,0);
    v_received := v_received + COALESCE(r.quantity_received,0);
    RAISE NOTICE '   % | % | status=% | shipped=% received=% | created % updated %',
      r.shipment_created, r.shipment_id, r.shipment_status,
      r.quantity_shipped, r.quantity_received, r.item_created, r.item_updated;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no shipment items recorded for this ASIN';
  END IF;
  RAISE NOTICE '   TOTAL over % shipment line(s): shipped % | received %', v_n, v_shipped, v_received;
  RAISE NOTICE '   compare: purchases recorded 1,254 | sold 1,245 + on hand 314 = 1,559 needed';

  RAISE NOTICE '';
  RAISE NOTICE '======== received quantity by month (the arrival timeline) ========';
  FOR r IN
    SELECT to_char(COALESCE(s.created_at, i.created_at),'YYYY-MM') AS mon,
           count(*) AS lines,
           sum(COALESCE(i.quantity_shipped,0)) AS shipped,
           sum(COALESCE(i.quantity_received,0)) AS received
    FROM public.fba_shipment_items i
    LEFT JOIN public.fba_shipments s
      ON s.user_id = i.user_id AND s.shipment_id = i.shipment_id
    WHERE i.user_id = v_uid AND (i.asin = v_asin OR i.seller_sku = v_sku)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % line(s), shipped %, received %', r.mon, r.lines, r.shipped, r.received;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== received before vs after the 7.75 lots (2026-05-24) ========';
  FOR r IN
    SELECT CASE WHEN COALESCE(s.created_at, i.created_at) < '2026-05-24'
                THEN 'before 2026-05-24' ELSE 'on/after 2026-05-24' END AS period,
           sum(COALESCE(i.quantity_received,0)) AS received,
           sum(COALESCE(i.quantity_shipped,0)) AS shipped
    FROM public.fba_shipment_items i
    LEFT JOIN public.fba_shipments s
      ON s.user_id = i.user_id AND s.shipment_id = i.shipment_id
    WHERE i.user_id = v_uid AND (i.asin = v_asin OR i.seller_sku = v_sku)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: received % (shipped %)', rpad(r.period,20), r.received, r.shipped;
  END LOOP;
  RAISE NOTICE '   purchases recorded before 2026-05-24: 954 | on/after: 300';

  RAISE NOTICE '';
  RAISE NOTICE '======== inbound placement fees -- posted when units are received ========';
  FOR r IN
    SELECT to_char(posted_date,'YYYY-MM') AS mon, count(*) AS events,
           round(sum(abs(fee_amount))::numeric,2) AS fees,
           min(posted_date) AS first_posted, max(posted_date) AS last_posted
    FROM public.fba_inbound_fees
    WHERE user_id = v_uid AND (asin = v_asin OR sku = v_sku)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % fee event(s), % total, posted % .. %',
      r.mon, r.events, r.fees, r.first_posted, r.last_posted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== inventory age signals ========';
  FOR r IN
    SELECT sku, first_received_at, estimated_age_days, age_confidence,
           preserved_since, listing_created_at
    FROM public.inventory WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   sku=%  first_received=%  est_age_days=%  confidence=%',
      r.sku, r.first_received_at, r.estimated_age_days, r.age_confidence;
    RAISE NOTICE '        preserved_since=%  listing_created=%', r.preserved_since, r.listing_created_at;
  END LOOP;
END
$probe$;
