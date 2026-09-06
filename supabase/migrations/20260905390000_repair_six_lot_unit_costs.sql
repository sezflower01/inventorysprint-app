-- REPAIR: six lots where the per-unit price was typed into the TOTAL box.
--
-- Approved by the seller 2026-09-05, both contested numbers confirmed by them:
-- B079STG3DR $14.92 (the May lot, distinct from the June lot at $16.16) and
-- B08BYX3C46 $2.00 (the figure typed, not the separate 4-unit listing at $5).
--
-- ---- MECHANISM ---------------------------------------------------------
-- The Created Listings purchase panel asks for UNITS and TOTAL COST and
-- divides. A per-unit figure typed into the total box therefore becomes
-- total/units -- a unit cost one or two orders of magnitude too small, which
-- then propagated into created_listing_purchases, created_listings,
-- cost_history and finally the locked snapshot on each order.
--
-- Confirmed independently on three of the six: the typed figure equals
-- inventory.cost (the UNIT field) for B00G3MJ0D2 ($4.86) and B079STG3DR
-- ($14.92), and typed x units equals inventory.amount (the TOTAL field) for
-- B07VXRVZHH ($10.79 x 100 = $1079) and B002J3OC7S ($12.32 x 30 = $369.60
-- against a recorded $369.51).
--
-- ---- WHY THIS IS SCOPED PER LOT, NOT PER ASIN --------------------------
-- B079STG3DR is the reason. It has a bad 2025-05-13 lot at $14.92/unit AND
-- nine good 2025-06-13 lots at $16.16/unit. An ASIN-wide correction would
-- have written $16.16 over orders that came from the May lot -- which is the
-- error caught during review. So every statement below keys on
-- (asin, lot date, units), and the order repair keys on the WRONG VALUE the
-- order actually carries rather than on the ASIN.
--
-- ---- NOT AN ERA --------------------------------------------------------
-- Measured 2026-09-05: 2024-03 ran 50% bad and 2024-04 ran 22%, holding 16 of
-- the 27 bad rows in the database, then twelve clean months. None of these six
-- are in that window; they are 2025 one-offs at 0.3-3.2% monthly rates. The
-- entry form, not the era, is the common cause -- and it is still live.
--
-- Reversible: before-state prints below.

BEGIN;

CREATE TEMP TABLE _lots (
  asin text, lot_date date, units int, unit_cost numeric
) ON COMMIT DROP;

INSERT INTO _lots VALUES
  ('B00JV57NOG', '2025-09-03',  26,  2.29),   -- GE A15 bulb;      typed $2.29
  ('B08BYX3C46', '2025-05-30',  20,  2.00),   -- (untitled);       typed $2.00
  ('B07VXRVZHH', '2025-10-06', 100, 10.79),   -- Lemax adapter;    typed $10.79
  ('B002J3OC7S', '2025-10-06',  30, 12.32),   -- KOHLER plunger;   typed $12.32
  ('B00G3MJ0D2', '2025-05-24',  50,  4.86),   -- undercabinet plate; typed $4.86
  ('B079STG3DR', '2025-05-13',  60, 14.92);   -- STIHL oil mix;    typed $14.92

-- ---- BEFORE -------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  RAISE NOTICE '================ BEFORE ================';
  FOR r IN
    SELECT l.asin, l.lot_date, l.units, l.unit_cost AS correct_unit,
           round(l.unit_cost * l.units, 2) AS correct_total,
           (SELECT count(*) FROM public.sales_orders s
             WHERE s.asin = l.asin
               AND COALESCE(s.unit_cost_at_sale, s.unit_cost) > 0
               AND COALESCE(s.unit_cost_at_sale, s.unit_cost) < 0.50) AS orders_to_fix,
           (SELECT round(sum(COALESCE(s.quantity,1) * (l.unit_cost - COALESCE(s.unit_cost_at_sale, s.unit_cost))), 2)
              FROM public.sales_orders s
             WHERE s.asin = l.asin
               AND COALESCE(s.unit_cost_at_sale, s.unit_cost) > 0
               AND COALESCE(s.unit_cost_at_sale, s.unit_cost) < 0.50) AS cogs_added
    FROM _lots l ORDER BY l.asin
  LOOP
    RAISE NOTICE '% lot % : % units @ $% (lot total $%) | % orders to fix | +$% COGS',
      r.asin, r.lot_date, r.units, r.correct_unit, r.correct_total, r.orders_to_fix, r.cogs_added;
  END LOOP;
END $$;

-- ---- 1. the purchase row that started it -------------------------------
UPDATE public.created_listing_purchases p
   SET unit_cost  = l.unit_cost,
       total_cost = round(l.unit_cost * l.units, 2),
       updated_at = now()
  FROM public.created_listings cl, _lots l
 WHERE p.listing_id = cl.id
   AND cl.asin = l.asin
   AND p.purchase_date::date = l.lot_date
   AND p.units = l.units;

-- ---- 2. the listing row for that lot (Contract A: cost=TOTAL, amount=UNIT)
UPDATE public.created_listings cl
   SET cost       = round(l.unit_cost * l.units, 2),
       amount     = l.unit_cost,
       updated_at = now()
  FROM _lots l
 WHERE cl.asin = l.asin
   AND cl.date_created::date = l.lot_date
   AND cl.units = l.units;

-- ---- 3. the immutable-ish ledger rung ----------------------------------
UPDATE public.cost_history h
   SET cost = l.unit_cost
  FROM _lots l
 WHERE h.asin = l.asin
   AND h.effective_date::date = l.lot_date;

-- ---- 4. the locked snapshots on the orders -----------------------------
-- Keyed on the WRONG VALUE, not the ASIN: only orders that actually took the
-- bad lot's cost are touched, so B079STG3DR's $16.16 orders and B00G3MJ0D2's
-- $4.98/$5.45 orders are left exactly as they are. cost_locked stays true --
-- the snapshot is still the right mechanism, it just held a wrong number.
UPDATE public.sales_orders s
   SET unit_cost           = l.unit_cost,
       unit_cost_at_sale   = l.unit_cost,
       total_cost          = round(l.unit_cost * COALESCE(s.quantity, 1), 2),
       cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field',
       updated_at          = now()
  FROM _lots l
 WHERE s.asin = l.asin
   AND COALESCE(s.unit_cost_at_sale, s.unit_cost) > 0
   AND COALESCE(s.unit_cost_at_sale, s.unit_cost) < 0.50;

-- ---- AFTER + post-conditions -------------------------------------------
DO $$
DECLARE r record; v_left int; v_bad_listing int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================ AFTER ================';
  FOR r IN
    SELECT l.asin,
           (SELECT count(*) FROM public.sales_orders s
             WHERE s.asin = l.asin AND s.cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field') AS repaired,
           (SELECT round(sum(COALESCE(s.quantity,1) * COALESCE(s.unit_cost_at_sale, s.unit_cost)), 2)
              FROM public.sales_orders s
             WHERE s.asin = l.asin AND s.cost_source_at_sale = 'lot_repair_v1:typed_unit_in_total_field') AS new_cogs
    FROM _lots l ORDER BY l.asin
  LOOP
    RAISE NOTICE '% : % orders repaired, now booking $% of COGS', r.asin, r.repaired, r.new_cogs;
  END LOOP;

  -- No order on these six may still carry a sub-50c cost.
  SELECT count(*) INTO v_left
    FROM public.sales_orders s JOIN _lots l ON l.asin = s.asin
   WHERE COALESCE(s.unit_cost_at_sale, s.unit_cost) > 0
     AND COALESCE(s.unit_cost_at_sale, s.unit_cost) < 0.50;
  RAISE NOTICE 'orders still under $0.50 on these six: %', v_left;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'repair incomplete -- % orders still under $0.50', v_left;
  END IF;

  -- And no repaired listing row may still violate Contract A.
  SELECT count(*) INTO v_bad_listing
    FROM public.created_listings cl JOIN _lots l ON l.asin = cl.asin AND cl.date_created::date = l.lot_date
   WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
     AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005);
  RAISE NOTICE 'repaired listing rows still inconsistent: %', v_bad_listing;
  IF v_bad_listing <> 0 THEN
    RAISE EXCEPTION 'listing repair incomplete -- % rows still inconsistent', v_bad_listing;
  END IF;
END $$;

COMMIT;
