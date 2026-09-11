-- PROBE (read-only): are the ~300 "missing" units of B0G4B3117X genuinely
-- unrecorded purchases, or an artefact of how I counted?
--
-- My arithmetic was: purchases 1,254 - clean sales 1,245 = 9 expected on hand,
-- against 311 actually on hand. Before asking the seller to dig up old
-- receipts, rule out the ways that sum could be wrong:
--
--   A. Lots entered under a DIFFERENT ASIN but the same SKU (or the same
--      product title). My total filtered on asin = B0G4B3117X, so those would
--      be invisible to it -- the most likely counting error.
--   B. Lots with NULL or zero units: sum() skips NULLs silently.
--   C. Soft-deleted/void lots being excluded (or included) wrongly.
--   D. Returns. A refunded unit goes back into sellable stock, so refunds
--      RAISE expected on-hand. I excluded 31 -REFUND rows from sales but never
--      credited them back, which understates expected stock.
--   E. Sales counted from more than one marketplace against a single pool.
--
-- And if the gap is real: WHEN did purchase entry stop? That answers whether
-- this is one missed batch or several.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
  v_cols text; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='created_listings'
    AND (column_name ILIKE '%delet%' OR column_name ILIKE '%void%' OR column_name ILIKE '%status%'
      OR column_name ILIKE '%archiv%' OR column_name ILIKE '%active%');
  RAISE NOTICE 'created_listings soft-delete-ish columns: %', COALESCE(v_cols, '(none)');

  RAISE NOTICE '';
  RAISE NOTICE '======== A. purchases by ASIN vs by SKU vs by title ========';
  FOR r IN
    SELECT 'asin = B0G4B3117X' AS scope, count(*) AS lots, sum(units) AS units,
           round(sum(cost)::numeric,2) AS spend
    FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin
    UNION ALL
    SELECT 'sku = A0N-DRF-MIOM (any asin)', count(*), sum(units), round(sum(cost)::numeric,2)
    FROM public.created_listings WHERE user_id = v_uid AND sku = v_sku
    UNION ALL
    SELECT 'title like Rumi (any asin/sku)', count(*), sum(units), round(sum(cost)::numeric,2)
    FROM public.created_listings WHERE user_id = v_uid AND title ILIKE '%Rumi%'
    UNION ALL
    SELECT 'title like Kpop Demon (any)', count(*), sum(units), round(sum(cost)::numeric,2)
    FROM public.created_listings WHERE user_id = v_uid AND title ILIKE '%Kpop Demon%'
  LOOP
    RAISE NOTICE '   %  lots=% units=% spend=%', rpad(r.scope,32), r.lots, r.units, r.spend;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== A2. any OTHER asin carrying this SKU or this title? ========';
  v_n := 0;
  FOR r IN
    SELECT asin, count(*) AS lots, sum(units) AS units, min(date_created) AS first_lot, max(date_created) AS last_lot
    FROM public.created_listings
    WHERE user_id = v_uid AND (sku = v_sku OR title ILIKE '%Kpop Demon%' OR title ILIKE '%Rumi%')
    GROUP BY asin ORDER BY sum(units) DESC
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   asin=%  lots=% units=%  (% .. %)', r.asin, r.lots, r.units, r.first_lot, r.last_lot;
  END LOOP;
  IF v_n <= 1 THEN RAISE NOTICE '   only one ASIN -- no mis-keyed lots hiding elsewhere'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== B/C. lots with no units, and any status column values ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE units IS NULL) AS null_units,
           count(*) FILTER (WHERE COALESCE(units,0) = 0) AS zero_units,
           count(*) AS lots
    FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   % lots | % with NULL units | % with zero units', r.lots, r.null_units, r.zero_units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. when were lots entered? (gap = when entry stopped) ========';
  FOR r IN
    SELECT to_char(date_created,'YYYY-MM') AS mon, count(*) AS lots, sum(units) AS units
    FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % lots, % units', r.mon, r.lots, r.units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. inventory row: its own units/amount figures ========';
  FOR r IN
    SELECT sku, units, cost, amount, available, reserved, inbound, unfulfilled
    FROM public.inventory WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   sku=% units=% cost(unit)=% amount(total)=%', r.sku, r.units, r.cost, r.amount;
    RAISE NOTICE '   available=% reserved=% inbound=% unfulfilled=%', r.available, r.reserved, r.inbound, r.unfulfilled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== D/E. full stock reconciliation ========';
  FOR r IN
    SELECT
      (SELECT sum(units) FROM public.created_listings WHERE user_id = v_uid AND asin = v_asin) AS bought,
      (SELECT sum(COALESCE(quantity,1)) FROM public.sales_orders
        WHERE user_id = v_uid AND asin = v_asin AND order_id NOT LIKE '%-REFUND'
          AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
          AND (is_cancelled IS NULL OR is_cancelled = false)) AS sold_clean,
      (SELECT COALESCE(sum(refund_quantity),0) FROM public.sales_orders
        WHERE user_id = v_uid AND asin = v_asin) AS refunded_units,
      (SELECT COALESCE(sum(COALESCE(quantity,1)),0) FROM public.sales_orders
        WHERE user_id = v_uid AND asin = v_asin AND order_id LIKE '%-REFUND') AS refund_rows_units,
      (SELECT COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(unfulfilled,0)
         FROM public.inventory WHERE user_id = v_uid AND asin = v_asin) AS on_hand
  LOOP
    RAISE NOTICE '   bought %  - sold %  + returns % = expected %',
      r.bought, r.sold_clean, r.refunded_units, r.bought - r.sold_clean + r.refunded_units;
    RAISE NOTICE '   actually on hand: %', r.on_hand;
    RAISE NOTICE '   UNEXPLAINED: % units', r.on_hand - (r.bought - r.sold_clean + r.refunded_units);
    RAISE NOTICE '   (-REFUND rows carry % units, already excluded from sold)', r.refund_rows_units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== E. sales by marketplace (one inventory pool serves all) ========';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mp, count(*) AS orders, sum(COALESCE(quantity,1)) AS units
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
    GROUP BY 1 ORDER BY units DESC
  LOOP
    RAISE NOTICE '   %: % orders, % units', rpad(r.mp,6), r.orders, r.units;
  END LOOP;
END
$probe$;