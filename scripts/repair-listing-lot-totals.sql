-- REPAIR (NOT YET APPLIED): created_listings.cost holds the UNIT cost instead
-- of the LOT TOTAL on 12 rows. Fixes 11 of them; the 12th needs a decision.
--
-- Deliberately in scripts/ and NOT in supabase/migrations/, so a routine
-- `supabase db push` cannot apply it by accident. Move it into migrations/
-- once approved.
--
-- ---- WHAT IS WRONG -----------------------------------------------------
-- Contract A: created_listings.cost = LOT TOTAL, .amount = UNIT cost. On these
-- rows both fields hold the same number, so the lot total reads as one unit.
-- It is user-visible: the Created Listings card derives its COG from
-- cost/units, so B0GNY5PGKS renders
--     Units 39 · COG $0.22 · Total $8.63
-- for an item whose real unit cost is $8.63 and whose lot cost $336.57.
--
-- ---- WHY `amount` IS THE SURVIVOR --------------------------------------
-- Confirmed by the seller directly on two rows (2026-09-05):
--   B0FK2YGWR2 "total cost 40 times 7, unit cost 7"       -> $280.00
--   B0GNY5PGKS "39 time 8.63, unit cost is 8.63"          -> $336.57
-- and structurally by sibling rows for the same SKU that were written
-- correctly. B0792DJ2LB carries a good row units=50 amount=2.98 cost=149.00
-- alongside the bad units=50 amount=2.98 cost=2.98 -- repairing the bad one
-- lands on exactly 149.00. B0GW6VWPGN has three good siblings at
-- units=5 amount=14.99 cost=74.95 against one bad at cost=14.99; the repair
-- reproduces 74.95.
--
-- ---- WHY 11 AND NOT 12 -------------------------------------------------
-- B00K2U7A1U's bad row (id 3b2a5787, created 2024-11-25) carries amount=11.21,
-- but created_listing_purchases for THAT date says 30 units @ $10.0097 =
-- $300.29; the 11.21 belongs to the 2025-01-30 lot. So on that row `amount` is
-- wrong too, and cost := amount * units would write $336.30 for a lot that
-- cost $300.29. It is excluded here rather than guessed at -- see the note at
-- the bottom for the two options.
--
-- ---- WHAT THIS DOES NOT CHANGE ------------------------------------------
-- Only .cost moves; .amount is untouched, so the COGS ladder -- which reads
-- the UNIT field -- returns exactly what it returns today. No sale, no P&L
-- figure and no locked snapshot changes. What moves is the LOT TOTAL readers:
-- the Created Listings card, getListingTotalCost in inventory-valuation.ts,
-- Suppliers.tsx and SyncedInventory.tsx.
--
-- Reversible: the before-state prints below, and the inverse is
-- `UPDATE ... SET cost = amount` on the same ids.

BEGIN;

CREATE TEMP TABLE _before ON COMMIT DROP AS
SELECT cl.id, cl.asin, cl.sku, cl.units, cl.cost AS old_cost, cl.amount,
       round(cl.amount * cl.units, 2) AS new_cost
FROM public.created_listings cl
WHERE COALESCE(cl.units, 0) > 1
  AND COALESCE(cl.amount, 0) > 0
  AND COALESCE(cl.cost, 0) > 0
  -- the exact defect signature: the unit value sitting in the total field
  AND abs(cl.cost - cl.amount) < 0.005
  AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
  -- exclude the row whose `amount` is itself suspect (see header)
  AND cl.id <> '3b2a5787-7088-4398-8023-792f1778794c'::uuid;

DO $$
DECLARE r record; n int := 0; v_delta numeric := 0;
BEGIN
  FOR r IN SELECT * FROM _before ORDER BY asin LOOP
    n := n + 1;
    v_delta := v_delta + (r.new_cost - r.old_cost);
    RAISE NOTICE '% % : % units @ $% | lot total $% -> $%',
      r.asin, r.sku, r.units, r.amount, r.old_cost, r.new_cost;
  END LOOP;
  RAISE NOTICE 'rows to repair: %  | recorded lot cost rises by $%', n, round(v_delta, 2);
  IF n <> 11 THEN
    RAISE EXCEPTION 'expected 11 rows, matched % -- data moved since verification; re-run the probes first', n;
  END IF;
END $$;

UPDATE public.created_listings cl
   SET cost = b.new_cost,
       updated_at = now()
  FROM _before b
 WHERE cl.id = b.id;

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.created_listings cl
   WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
     AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005);
  RAISE NOTICE 'created_listings still inconsistent after repair: % (expect 1 -- the excluded B00K2U7A1U row)', v_left;
  IF v_left <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 row left, found %', v_left;
  END IF;
END $$;

COMMIT;

-- ---- THE EXCLUDED ROW: pick one, then run it separately -----------------
--
-- Option A -- trust its own purchase record (30 @ $10.0097 on 2024-11-25).
-- Repairs BOTH fields, so the historical lot reads as what was actually paid:
--
--   UPDATE public.created_listings
--      SET amount = 10.0097, cost = 300.29, updated_at = now()
--    WHERE id = '3b2a5787-7088-4398-8023-792f1778794c';
--
-- Option B -- treat amount=11.21 as correct and only fix the total:
--
--   UPDATE public.created_listings
--      SET cost = 336.30, updated_at = now()
--    WHERE id = '3b2a5787-7088-4398-8023-792f1778794c';
--
-- Option A is better supported. The row is superseded by a good 2025-01-30
-- row carrying exactly amount=11.2103 / cost=336.31, which is where the 11.21
-- on this older row appears to have come from.
