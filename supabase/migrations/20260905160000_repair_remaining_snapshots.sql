-- Finish the snapshot repair.
--
-- The first pass filtered on cost_source_at_sale LIKE
-- 'fallback_current_inventory%' and left six rows behind: the poisoned
-- inventory row was reachable from more than one rung, so the same corrupted
-- value got snapshotted under other source labels too.
--
-- The RATIO is what identifies the damage -- a snapshot equal to the
-- listing's lot total and unequal to its unit cost. The source label is now
-- reported for the record rather than used as a filter, since filtering on it
-- is what caused the miss.

DO $$
DECLARE r RECORD; v_fixed int := 0; v_delta numeric := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.order_id, s.asin, s.quantity, s.cost_source_at_sale AS src,
           s.unit_cost_at_sale AS bad, cl.amount AS good
    FROM public.sales_orders s
    JOIN LATERAL (
      SELECT c.amount, c.cost, c.units FROM public.created_listings c
      WHERE c.user_id = s.user_id AND (c.sku = s.sku OR c.asin = s.asin)
        AND c.amount IS NOT NULL AND c.amount > 0
      ORDER BY (c.sku = s.sku) DESC, c.updated_at DESC LIMIT 1
    ) cl ON true
    WHERE s.unit_cost_at_sale IS NOT NULL AND cl.units > 1
      AND abs(s.unit_cost_at_sale - cl.cost) < 0.02
      AND abs(s.unit_cost_at_sale - cl.amount) > 0.02
  LOOP
    UPDATE public.sales_orders
       SET unit_cost_at_sale = round(r.good, 4),
           unit_cost         = round(r.good, 4),
           total_cost        = round(r.good * COALESCE(r.quantity, 0), 2),
           cost_source_at_sale = 'repaired_from_listing:amount',
           updated_at = now()
     WHERE id = r.id;
    v_fixed := v_fixed + 1;
    v_delta := v_delta + (r.bad - r.good) * COALESCE(r.quantity, 0);
    RAISE NOTICE '  % (%) [was %]: % -> %, qty %',
      r.order_id, r.asin, r.src, r.bad, round(r.good, 4), r.quantity;
  END LOOP;
  RAISE NOTICE 'repaired %: overstated COGS removed $%', v_fixed, round(v_delta, 2);
END $$;

DO $$
DECLARE v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM public.sales_orders s
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
END $$;
