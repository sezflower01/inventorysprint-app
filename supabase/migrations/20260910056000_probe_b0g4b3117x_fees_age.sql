-- PROBE (read-only): B0G4B3117X -- the two sections the receipts probe never
-- reached before its output was cut off.
--
-- Why these, specifically. fba_shipment_items cannot date anything: its
-- created_at is when the sync wrote the row (every April line reads 04-25 or
-- 04-28, every July line 07-04), and many CLOSED April shipments show
-- quantity_received = 0 because the sync never backfilled receipts -- not
-- because stock never arrived. It also only accounts for 525 received against
-- the 1,559 units that must have existed. So it is incomplete AND undated.
--
-- fba_inbound_fees.posted_date is Amazon's own posting date for a charge raised
-- when units are received, which makes it an independent arrival timeline that
-- the sync cannot have back-dated. That is the last realistic way to learn
-- whether the ~305 unrecorded units arrived before or after the 7.75 lots
-- (dated 2026-05-24/25) without asking the seller.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
  v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== inbound placement fees by month (Amazon posting date) ========';
  FOR r IN
    SELECT to_char(posted_date,'YYYY-MM') AS mon, count(*) AS events,
           round(sum(abs(fee_amount))::numeric,2) AS fees,
           min(posted_date) AS first_posted, max(posted_date) AS last_posted,
           count(DISTINCT shipment_id) AS shipments
    FROM public.fba_inbound_fees
    WHERE user_id = v_uid AND (asin = v_asin OR sku = v_sku)
    GROUP BY 1 ORDER BY 1
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   %: % event(s) across % shipment(s), % total, posted % .. %',
      r.mon, r.events, r.shipments, r.fees, r.first_posted, r.last_posted;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no inbound fee events recorded against this ASIN or SKU';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== fee events before vs after the 7.75 lots ========';
  FOR r IN
    SELECT CASE WHEN posted_date < '2026-05-24' THEN 'before 2026-05-24'
                ELSE 'on/after 2026-05-24' END AS period,
           count(*) AS events, count(DISTINCT shipment_id) AS shipments,
           round(sum(abs(fee_amount))::numeric,2) AS fees
    FROM public.fba_inbound_fees
    WHERE user_id = v_uid AND (asin = v_asin OR sku = v_sku)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % event(s), % shipment(s), % fees',
      rpad(r.period,20), r.events, r.shipments, r.fees;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what the fee events describe ========';
  FOR r IN
    SELECT fee_type, count(*) AS n, min(posted_date) AS first_posted, max(posted_date) AS last_posted
    FROM public.fba_inbound_fees
    WHERE user_id = v_uid AND (asin = v_asin OR sku = v_sku)
    GROUP BY 1 ORDER BY n DESC LIMIT 8
  LOOP
    RAISE NOTICE '   %: % event(s), % .. %', rpad(r.fee_type,36), r.n, r.first_posted, r.last_posted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the July shipment ids -- do they match fee events? ========';
  -- The July shipments received 370 of 373 units. If their inbound fees posted
  -- in July, the ~305 unrecorded units most likely arrived AFTER the 7.75 lots.
  FOR r IN
    SELECT f.shipment_id, min(f.posted_date) AS posted, count(*) AS events
    FROM public.fba_inbound_fees f
    WHERE f.user_id = v_uid AND (f.asin = v_asin OR f.sku = v_sku)
      AND f.shipment_id IN (
        SELECT i.shipment_id FROM public.fba_shipment_items i
        WHERE i.user_id = v_uid AND (i.asin = v_asin OR i.seller_sku = v_sku)
      )
    GROUP BY f.shipment_id ORDER BY min(f.posted_date) LIMIT 30
  LOOP
    RAISE NOTICE '   % posted % (% event(s))', r.shipment_id, r.posted, r.events;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== inventory age signals ========';
  FOR r IN
    SELECT sku, first_received_at, estimated_age_days, age_confidence,
           preserved_since, listing_created_at,
           COALESCE(available,0) AS av, COALESCE(reserved,0) AS rv
    FROM public.inventory WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   sku=% on hand=%  first_received=%  est_age_days=%  confidence=%',
      r.sku, r.av + r.rv, r.first_received_at, r.estimated_age_days, r.age_confidence;
    RAISE NOTICE '        preserved_since=%  listing_created=%', r.preserved_since, r.listing_created_at;
  END LOOP;
END
$probe$;
