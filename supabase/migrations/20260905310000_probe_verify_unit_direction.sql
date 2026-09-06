-- PROBE (read-only): for each of the 12 inconsistent created_listings rows,
-- is `amount` the true UNIT cost, or is `cost` the true LOT TOTAL?
--
-- Both fields hold the SAME number, so exactly one of them is wrong, and the
-- repair goes in opposite directions depending on which:
--
--   amount is the unit  ->  cost   should become amount * units   (40 x 7 = 280)
--   cost   is the total ->  amount should become cost / units     (7 / 40 = 0.18)
--
-- Guessing here would bake a 40x error into the cost ladder permanently, so
-- this asks three sources that were written by different code paths and have
-- no reason to agree unless they are right:
--
--   inventory.cost    -- UNIT cost under Contract A (inverted vs created_listings)
--   cost_history.cost -- immutable ledger, rung 3a
--   sale price        -- a unit cost above the selling price is impossible
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int := 0; v_agree int := 0; v_disagree int := 0;
BEGIN
  RAISE NOTICE '===== which field is wrong? =====';
  FOR r IN
    SELECT cl.asin, cl.sku, cl.units, cl.cost, cl.amount,
           round(cl.amount * cl.units, 2)          AS total_if_amount_is_unit,
           round(cl.cost / NULLIF(cl.units,0), 4)  AS unit_if_cost_is_total,
           i.cost                                  AS inventory_unit,
           i.units                                 AS stock,
           h.cost                                  AS cost_history_unit,
           sp.min_price, sp.max_price, sp.orders,
           left(COALESCE(cl.title,''), 30)         AS title
    FROM public.created_listings cl
    LEFT JOIN public.inventory i
           ON i.user_id = cl.user_id AND i.sku = cl.sku
    LEFT JOIN LATERAL (
      SELECT h2.cost FROM public.cost_history h2
       WHERE h2.user_id = cl.user_id AND h2.sku = cl.sku
       ORDER BY h2.effective_date DESC LIMIT 1
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT round(min(NULLIF(s.item_price,0)),2) AS min_price,
             round(max(s.item_price),2)           AS max_price,
             count(*)                             AS orders
        FROM public.sales_orders s
       WHERE s.user_id = cl.user_id AND s.asin = cl.asin
    ) sp ON true
    WHERE COALESCE(cl.units,0) > 0 AND COALESCE(cl.amount,0) > 0 AND COALESCE(cl.cost,0) > 0
      AND abs(cl.cost - cl.amount * cl.units) > GREATEST(0.01, abs(cl.amount * cl.units) * 0.005)
    ORDER BY cl.asin
  LOOP
    n := n + 1;
    -- "agree" = an independent source matches `amount`, i.e. amount IS the unit.
    IF (r.inventory_unit IS NOT NULL AND abs(r.inventory_unit - r.amount) < 0.005)
       OR (r.cost_history_unit IS NOT NULL AND abs(r.cost_history_unit - r.amount) < 0.005)
    THEN v_agree := v_agree + 1;
    ELSE v_disagree := v_disagree + 1;
    END IF;

    RAISE NOTICE '% % units=% | amount=% cost=% | inv.cost=% hist=% | sold %..% (% orders) | -> total would be % / unit would be % | %',
      r.asin, r.sku, r.units, r.amount, r.cost,
      r.inventory_unit, r.cost_history_unit,
      r.min_price, r.max_price, r.orders,
      r.total_if_amount_is_unit, r.unit_if_cost_is_total, r.title;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'rows=%  | independent source confirms amount IS the unit: %  | unconfirmed: %',
    n, v_agree, v_disagree;
  RAISE NOTICE 'Repair is safe ONLY for the confirmed rows: cost := amount * units.';
END
$probe$;
