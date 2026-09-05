-- Repair locked sale-time cost snapshots that froze the corrupted unit cost.
--
-- ---- WHY THE EARLIER FIX WAS NOT ENOUGH ---------------------------------
--
-- bulk-live-verify wrote created_listings.cost (a LOT TOTAL) into
-- inventory.cost (per unit). That was fixed and the 13 damaged inventory rows
-- were repaired. The dashboard still showed -$2,157.92 on two units.
--
-- The reason is that sales_orders snapshots the resolved unit cost AT SALE and
-- LOCKS it:
--
--   order 114-4174797-0294657
--     unit_cost            21.58                            (correct)
--     unit_cost_at_sale    2136.34                          (the lot total)
--     cost_source_at_sale  fallback_current_inventory:sku
--     cost_locked          true
--
-- The order synced while inventory.cost was poisoned, the ladder fell through
-- to its lowest rung, took 2136.34 and locked it. Tier 1 of resolve_unit_cost
-- is that locked snapshot, so it outranks every later correction -- by design,
-- because historical sales must not silently re-cost when someone edits a
-- purchase months on. 2136.34 + 21.58 = 2157.92, which is exactly what the
-- card showed.
--
-- Locking is right; locking CORRUPTION is not. A snapshot of a bad read is not
-- a historical record, it is the same bug frozen where nothing downstream can
-- reach it.
--
-- ---- WHAT IS TOUCHED, AND WHAT IS NOT -----------------------------------
--
-- Only rows that are all of:
--   * sourced from fallback_current_inventory (the rung that was poisoned),
--   * whose snapshot equals the listing's LOT TOTAL, and
--   * whose snapshot differs from that listing's own unit cost.
--
-- A snapshot taken from cost_history, a purchase batch or a manual override is
-- never rewritten, and neither is one that already agrees with the unit cost.
-- The test is the ratio, not the size, so genuinely expensive stock is safe.

DO $$
DECLARE r RECORD; v_fixed int := 0; v_delta numeric := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.order_id, s.asin, s.quantity,
           s.unit_cost_at_sale AS bad, cl.amount AS good, cl.units
    FROM public.sales_orders s
    JOIN LATERAL (
      SELECT c.amount, c.cost, c.units
      FROM public.created_listings c
      WHERE c.user_id = s.user_id
        AND (c.sku = s.sku OR c.asin = s.asin)
        AND c.amount IS NOT NULL AND c.amount > 0
      ORDER BY (c.sku = s.sku) DESC, c.updated_at DESC
      LIMIT 1
    ) cl ON true
    WHERE s.unit_cost_at_sale IS NOT NULL
      AND s.cost_source_at_sale LIKE 'fallback_current_inventory%'
      AND cl.units > 1
      AND abs(s.unit_cost_at_sale - cl.cost) < 0.02      -- it IS the lot total
      AND abs(s.unit_cost_at_sale - cl.amount) > 0.02    -- and NOT the unit cost
  LOOP
    UPDATE public.sales_orders
       SET unit_cost_at_sale  = round(r.good, 4),
           unit_cost          = round(r.good, 4),
           total_cost         = round(r.good * COALESCE(r.quantity, 0), 2),
           -- Re-sourced from the listing, so the label must say so rather than
           -- keep claiming an inventory fallback that no longer applies.
           cost_source_at_sale = 'repaired_from_listing:amount',
           updated_at = now()
     WHERE id = r.id;
    v_fixed := v_fixed + 1;
    v_delta := v_delta + (r.bad - r.good) * COALESCE(r.quantity, 0);
    RAISE NOTICE '  % (%): % -> % per unit, qty %',
      r.order_id, r.asin, r.bad, round(r.good, 4), r.quantity;
  END LOOP;
  RAISE NOTICE 'orders repaired: % | overstated COGS removed: $%',
    v_fixed, round(v_delta, 2);
END $$;

DO $$
DECLARE v_left bigint; v_sum numeric;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.sales_orders s
  JOIN LATERAL (
    SELECT c.amount, c.cost, c.units FROM public.created_listings c
    WHERE c.user_id = s.user_id AND (c.sku = s.sku OR c.asin = s.asin)
      AND c.amount IS NOT NULL AND c.amount > 0
    ORDER BY (c.sku = s.sku) DESC, c.updated_at DESC LIMIT 1
  ) cl ON true
  WHERE s.unit_cost_at_sale IS NOT NULL AND cl.units > 1
    AND abs(s.unit_cost_at_sale - cl.cost) < 0.02
    AND abs(s.unit_cost_at_sale - cl.amount) > 0.02;
  RAISE NOTICE 'locked snapshots still holding a lot total: % (want 0)', v_left;

  SELECT COALESCE(sum(COALESCE(unit_cost_at_sale, unit_cost) * quantity), 0) INTO v_sum
  FROM public.sales_orders
  WHERE asin = 'B0G2YNN87D' AND order_date >= current_date - 1;
  RAISE NOTICE 'the Nerf sword, last 24h COGS: $% (was 2157.92)', round(v_sum, 2);
END $$;
