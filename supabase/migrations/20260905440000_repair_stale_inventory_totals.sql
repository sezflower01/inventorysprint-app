-- REPAIR: recompute the stale TOTAL on 85 inventory rows.
--
-- Approved by the seller 2026-09-05, on the explicit understanding that no
-- past report changes: `cost` is untouched, and `cost` is what the P&L reads.
--
-- ---- WHAT IS WRONG -----------------------------------------------------
-- Contract A for inventory: cost = UNIT, amount = TOTAL (the inverse of
-- created_listings). On these rows `amount` is a total that was correct at an
-- earlier stock level and never recomputed as units moved. Established rather
-- than assumed on 2026-09-05: `cost` sits below the sale price on 85 of 85,
-- while amount/units would be under 5% of the sale price on 29 of them, and
-- amount/cost lands on clean whole numbers -- 69, 50, 50, 12, 11, 5, 4, 1 --
-- which is what a total left behind by a stock change looks like.
--
-- ---- WHY IT IS WORTH FIXING WITH ZERO P&L IMPACT -----------------------
-- resolve_unit_cost_v1 rung 5 reads inventory.cost, which is right, so no
-- booked order is wrong and no month moves. The hazard is forward-looking:
-- getInventoryUnitCostSafe cross-checks cost against amount/units and, on
-- disagreement, prefers the SMALLER derived value. So a NEW sale on this
-- stock can be written and locked at amount/units --
--     B0G4B3117X   586 units   correct $14.56   Safe would write $1.71
--     B0G54FYGXQ   245 units   correct $16.70   Safe would write $0.07
-- Across all 85 rows that is $31,739.42 of COGS understated if the 4,357
-- units currently in stock sell before this runs.
--
-- ---- SCOPE -------------------------------------------------------------
-- Only the 85 rows where amount/units < cost, i.e. the understating class.
-- A further 131 rows are inconsistent in the OTHER direction (amount/units
-- above cost); there the Safe helper refuses and returns null rather than
-- understating, which surfaces as cost_invalid instead of a wrong number.
-- Different symptom, not approved here, left alone deliberately.
--
-- Reversible: the before-state prints below.

BEGIN;

CREATE TEMP TABLE _stale ON COMMIT DROP AS
SELECT i.id, i.asin, i.sku, i.units, i.cost,
       i.amount                        AS old_amount,
       round(i.cost * i.units, 2)      AS new_amount
FROM public.inventory i
WHERE COALESCE(i.units, 0) > 0
  AND COALESCE(i.cost, 0) > 0
  AND COALESCE(i.amount, 0) > 0
  AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
  AND i.amount / NULLIF(i.units, 0) < i.cost;

DO $$
DECLARE r record; n int; v_old numeric; v_new numeric;
BEGIN
  SELECT count(*), round(sum(old_amount),2), round(sum(new_amount),2)
    INTO n, v_old, v_new FROM _stale;
  RAISE NOTICE '================ BEFORE ================';
  RAISE NOTICE '% rows | recorded valuation $% -> $% (+$%)', n, v_old, v_new, round(v_new - v_old, 2);
  IF n <> 85 THEN
    RAISE EXCEPTION 'expected 85 rows, matched % -- data moved since verification; re-run the probes', n;
  END IF;
  RAISE NOTICE '-- ten largest --';
  FOR r IN SELECT * FROM _stale ORDER BY (new_amount - old_amount) DESC LIMIT 10 LOOP
    RAISE NOTICE '   % % : % units @ $% | total $% -> $%',
      r.asin, r.sku, r.units, r.cost, r.old_amount, r.new_amount;
  END LOOP;
END $$;

UPDATE public.inventory i
   SET amount = s.new_amount,
       updated_at = now()
  FROM _stale s
 WHERE i.id = s.id;

DO $$
DECLARE v_left int; v_other int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.inventory i
   WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
     AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005)
     AND i.amount / NULLIF(i.units,0) < i.cost;
  SELECT count(*) INTO v_other
    FROM public.inventory i
   WHERE COALESCE(i.units,0) > 0 AND COALESCE(i.cost,0) > 0 AND COALESCE(i.amount,0) > 0
     AND abs(i.amount - i.cost * i.units) > GREATEST(0.01, abs(i.cost * i.units) * 0.005);
  RAISE NOTICE '';
  RAISE NOTICE '================ AFTER ================';
  RAISE NOTICE 'understating rows left: % (expect 0)', v_left;
  RAISE NOTICE 'inconsistent rows left in the OTHER direction: % (out of scope, see header)', v_other;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'repair incomplete -- % understating rows remain', v_left;
  END IF;
END $$;

COMMIT;
