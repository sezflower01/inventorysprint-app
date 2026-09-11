-- PROBE (read-only): recompute the B0G4B3117X reconciliation with the two
-- confirmed test duplicates removed.
--
-- The seller confirms "bath Copy" and "The Road Copy" were created while
-- trying the duplicate feature and are not real shipments. Both were
-- continued, which is why they double-counted; the other Copy rows are NOT
-- duplicates in the same sense -- "Deere Copy" and "zoey Copy" are the
-- CONTINUED ones and their originals were archived, so a blanket
-- name-like-Copy exclusion would wrongly delete 135 real units.
--
-- Checks:
--   1. corrected continued total
--   2. implied pre-Builder stock, solved from Amazon's own figures
--   3. that the running balance never goes negative at any week -- the test
--      that the corrected number is actually self-consistent rather than just
--      smaller
--   4. any OTHER same-day, same-quantity continued pairs that might also be
--      duplicates the seller has not spotted
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE
  r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
  v_continued numeric; v_corrected numeric; v_pre numeric;
  v_sold numeric; v_returns numeric; v_onhand numeric; v_min_balance numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. continued shipments, named ========';
  FOR r IN
    WITH per_draft AS (
      SELECT d.draft_id, d.shipment_name, d.created_at::date AS day,
             max(COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric)) AS qty
      FROM public.shipment_builder_drafts d
      CROSS JOIN LATERAL jsonb_path_query(
        d.payload,
        '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
        jsonb_build_object('a', v_asin, 's', v_sku)
      ) AS obj
      WHERE d.user_id = v_uid AND d.status = 'continued'
      GROUP BY d.draft_id, d.shipment_name, d.created_at
    )
    SELECT day, shipment_name, qty,
           (shipment_name IN ('bath Copy', 'The Road Copy')) AS excluded
    FROM per_draft ORDER BY day, shipment_name
  LOOP
    RAISE NOTICE '   % %  qty=% %', r.day, rpad(COALESCE(r.shipment_name,'(unnamed)'),16), r.qty,
      CASE WHEN r.excluded THEN '   <- EXCLUDED (test duplicate)' ELSE '' END;
  END LOOP;

  WITH per_draft AS (
    SELECT d.draft_id, d.shipment_name,
           max(COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric)) AS qty
    FROM public.shipment_builder_drafts d
    CROSS JOIN LATERAL jsonb_path_query(
      d.payload,
      '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
      jsonb_build_object('a', v_asin, 's', v_sku)
    ) AS obj
    WHERE d.user_id = v_uid AND d.status = 'continued'
    GROUP BY d.draft_id, d.shipment_name
  )
  SELECT sum(qty), sum(qty) FILTER (WHERE shipment_name NOT IN ('bath Copy','The Road Copy')
                                       OR shipment_name IS NULL)
    INTO v_continued, v_corrected
  FROM per_draft;

  SELECT sum(COALESCE(quantity,1)) INTO v_sold
  FROM public.sales_orders WHERE user_id = v_uid AND asin = v_asin
    AND order_id NOT LIKE '%-REFUND'
    AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled');
  SELECT COALESCE(sum(refund_quantity),0) INTO v_returns
  FROM public.sales_orders WHERE user_id = v_uid AND asin = v_asin;
  SELECT COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(unfulfilled,0) INTO v_onhand
  FROM public.inventory WHERE user_id = v_uid AND asin = v_asin;

  v_pre := v_onhand + (v_sold - v_returns) - v_corrected;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. the corrected reconciliation ========';
  RAISE NOTICE '   continued as counted        : %', v_continued;
  RAISE NOTICE '   less the two test duplicates: -125';
  RAISE NOTICE '   CORRECTED continued         : %', v_corrected;
  RAISE NOTICE '';
  RAISE NOTICE '   sold % - returned to stock % = % consumed', v_sold, v_returns, v_sold - v_returns;
  RAISE NOTICE '   still on hand               : %', v_onhand;
  RAISE NOTICE '   so units that arrived       : %', v_onhand + (v_sold - v_returns);
  RAISE NOTICE '   arrived via Shipment Builder: %', v_corrected;
  RAISE NOTICE '   => arrived BEFORE Builder   : %', v_pre;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. does it hold week by week? (balance must never go below 0) ========';
  v_min_balance := NULL;
  FOR r IN
    WITH arrivals AS (
      SELECT d.created_at::date AS day, d.shipment_name,
             max(COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric)) AS qty
      FROM public.shipment_builder_drafts d
      CROSS JOIN LATERAL jsonb_path_query(
        d.payload,
        '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
        jsonb_build_object('a', v_asin, 's', v_sku)
      ) AS obj
      WHERE d.user_id = v_uid AND d.status = 'continued'
        AND (d.shipment_name NOT IN ('bath Copy','The Road Copy') OR d.shipment_name IS NULL)
      GROUP BY d.draft_id, d.created_at::date, d.shipment_name
    ),
    arr_day AS (SELECT day, sum(qty) AS qty FROM arrivals GROUP BY day),
    sales_day AS (
      SELECT order_date AS day, sum(COALESCE(quantity,1)) AS qty
      FROM public.sales_orders
      WHERE user_id = v_uid AND asin = v_asin AND order_id NOT LIKE '%-REFUND'
        AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
      GROUP BY order_date
    ),
    days AS (SELECT day FROM arr_day UNION SELECT day FROM sales_day),
    joined AS (
      SELECT d.day,
             sum(COALESCE(a.qty,0)) OVER (ORDER BY d.day) AS cum_in,
             sum(COALESCE(s.qty,0)) OVER (ORDER BY d.day) AS cum_out
      FROM days d
      LEFT JOIN arr_day a ON a.day = d.day
      LEFT JOIN sales_day s ON s.day = d.day
    )
    SELECT date_trunc('week', day)::date AS wk,
           max(cum_in) AS cum_in, max(cum_out) AS cum_out,
           min(v_pre + cum_in - cum_out) AS balance_low
    FROM joined GROUP BY 1 ORDER BY 1
  LOOP
    IF v_min_balance IS NULL OR r.balance_low < v_min_balance THEN v_min_balance := r.balance_low; END IF;
    RAISE NOTICE '   week %  in=% out=%  balance low=%',
      r.wk, lpad(r.cum_in::text,5), lpad(r.cum_out::text,5), lpad(r.balance_low::text,5);
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '   lowest balance across the whole period: %', v_min_balance;
  IF v_min_balance >= 0 THEN
    RAISE NOTICE '   -> consistent: stock never goes negative. The corrected figure holds.';
  ELSE
    RAISE NOTICE '   -> IMPOSSIBLE: stock goes negative, so % pre-Builder units cannot be right', v_pre;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. other same-day, same-quantity continued pairs? ========';
  FOR r IN
    WITH per_draft AS (
      SELECT d.created_at::date AS day, d.shipment_name,
             max(COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric)) AS qty
      FROM public.shipment_builder_drafts d
      CROSS JOIN LATERAL jsonb_path_query(
        d.payload,
        '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
        jsonb_build_object('a', v_asin, 's', v_sku)
      ) AS obj
      WHERE d.user_id = v_uid AND d.status = 'continued'
      GROUP BY d.draft_id, d.created_at::date, d.shipment_name
    )
    SELECT day, qty, count(*) AS n, string_agg(shipment_name, ' + ' ORDER BY shipment_name) AS names
    FROM per_draft GROUP BY day, qty HAVING count(*) > 1
    ORDER BY day
  LOOP
    RAISE NOTICE '   % : % x % units  -> %', r.day, r.n, r.qty, r.names;
  END LOOP;
END
$probe$;