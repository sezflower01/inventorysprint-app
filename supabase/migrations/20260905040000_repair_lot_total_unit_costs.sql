-- Repair inventory rows that carry a LOT TOTAL in the per-unit cost field.
--
-- ---- WHAT HAPPENED ------------------------------------------------------
--
-- bulk-live-verify created inventory rows from created_listings with
-- `cost: cl.cost`. But created_listings.cost is the LOT TOTAL and `amount` is
-- the unit cost -- verified 2026-09-05: cost / units equals amount on 6,876 of
-- 6,889 multi-unit listings.
--
-- So a whole purchase order landed in a per-unit field. B0G2YNN87D carried
-- $2,136.34 per unit instead of $21.58, and a two-unit sale of a foam sword
-- reported -$2,157.92 of COGS against $81.95 of revenue: exactly
-- 2136.34 + 21.58, one unit costed from the poisoned inventory row and one
-- from the correct sales figure.
--
-- Six rows were affected, all written between 01:35 and 03:49 on 2026-09-05 --
-- a live writer, not historical damage. The function is fixed; this repairs
-- what it already wrote.
--
-- ---- WHY THE THRESHOLD IS A RATIO, NOT A PRICE --------------------------
--
-- "cost over $300" would be wrong: some inventory genuinely costs that. What
-- identifies the damage is the cost being a MULTIPLE of the listing's own unit
-- cost, by very close to the unit count. Anything whose stored cost already
-- matches `amount` is left alone, so a legitimately expensive item is never
-- touched.

DO $$
DECLARE r RECORD; v_fixed int := 0;
BEGIN
  FOR r IN
    SELECT i.id, i.sku, i.asin, i.cost AS bad_cost,
           cl.amount AS unit_cost, cl.units
    FROM public.inventory i
    JOIN LATERAL (
      SELECT c.amount, c.units, c.cost
      FROM public.created_listings c
      WHERE c.asin = i.asin AND c.user_id = i.user_id
        AND c.amount IS NOT NULL AND c.amount > 0
      ORDER BY c.updated_at DESC LIMIT 1
    ) cl ON true
    WHERE i.cost IS NOT NULL
      AND cl.units > 1
      -- The stored cost is the lot total, not the unit cost.
      AND abs(i.cost - cl.cost) < 0.02
      AND abs(i.cost - cl.amount) > 0.02
  LOOP
    UPDATE public.inventory SET cost = round(r.unit_cost, 4), updated_at = now()
     WHERE id = r.id;
    v_fixed := v_fixed + 1;
    RAISE NOTICE '  % (%): % -> % (lot of % units)',
      r.sku, r.asin, r.bad_cost, round(r.unit_cost, 4), r.units;
  END LOOP;
  RAISE NOTICE 'inventory rows repaired: %', v_fixed;
END $$;

DO $$
DECLARE v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM public.inventory i
  JOIN LATERAL (
    SELECT c.amount, c.units, c.cost FROM public.created_listings c
    WHERE c.asin = i.asin AND c.user_id = i.user_id
      AND c.amount IS NOT NULL AND c.amount > 0
    ORDER BY c.updated_at DESC LIMIT 1
  ) cl ON true
  WHERE i.cost IS NOT NULL AND cl.units > 1
    AND abs(i.cost - cl.cost) < 0.02 AND abs(i.cost - cl.amount) > 0.02;
  RAISE NOTICE 'rows still holding a lot total: % (want 0)', v_left;
END $$;
