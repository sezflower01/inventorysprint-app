-- READ-ONLY PROBE. Seller Central shows order 702-5492481-4068251 (CA,
-- B002HJ4HSS, SKU KVB-CBK-JRNR, purchased 2026-10-06 18:05 PDT, qty 1) at
-- CA$34.13. Live Sales and the Sales Report show $14.56.
--
-- CA$34.13 is not $14.56 at any plausible rate -- 0.72 would give $24.57, and
-- 14.56/34.13 is 0.4266, which is not a currency. So this is not an FX bug on
-- the right number; it is the wrong number.
--
-- The order is still PENDING, which is the condition under which this app
-- substitutes an estimate for a price it does not have yet. Three known traps
-- converge here, so find out which one fired before changing anything:
--   * the pending estimator reads prices WE submitted, not the observed Buy Box
--   * `|| 0` price fallbacks book unknown prices as $0.00
--   * order_status never leaves Pending, so "pending" logic applies forever

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== sales_orders columns (so the next probe stops guessing) ==';
  FOR r IN SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sales_orders' LOOP
    RAISE NOTICE '  %', r.cols;
  END LOOP;
END
$p$;
