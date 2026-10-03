-- READ-ONLY PROBE. B0CKJNCZLY 2026 with the refund modelled correctly.
--
-- The 4.6% I quoted subtracted the GROSS refund ($1,837.98) from a profit that
-- had already had those same orders' fees deducted. That is wrong twice over:
-- Amazon credits the referral fee back on a refund and keeps only the FBA fee
-- plus min($5, 20% x referral) of administration, and a returned unit that is
-- resellable gives its COGS back too.
--
-- Net cost of ONE returned unit, therefore, is not the refunded price. It is:
--     FBA fee  +  admin retention  (+ COGS, only if the unit is written off)
-- which is why this is computed two ways -- returns resold, returns written off
-- -- and the truth sits between them.
--
-- Also settles the unit count: returns live BOTH as refund_quantity on the
-- parent order AND as separate "-REFUND" rows, with only 9 orders carrying
-- both, so neither source alone is the total.

DO $p$
DECLARE
  r record;   -- the monthly/disposition loops need this; its absence was the 42601
  v_uid uuid;
  v_rev numeric; v_fees numeric; v_cogs numeric; v_units int;
  v_ref_parent int; v_ref_rows int; v_ref_both int; v_ref_total int;
  v_fba_unit numeric; v_ref_fee_unit numeric; v_admin numeric; v_cog numeric;
  v_gross numeric; v_ret_cost numeric; v_net_resold numeric; v_net_writeoff numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- clean sales only: real prices, no -REFUND rows
  SELECT sum(COALESCE(total_sale_amount, sold_price * quantity)),
         sum(COALESCE(total_fees, 0)),
         sum(COALESCE(unit_cost_at_sale, unit_cost, 0) * quantity),
         sum(quantity)
    INTO v_rev, v_fees, v_cogs, v_units
  FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false
    AND order_id NOT LIKE '%-REFUND'
    AND COALESCE(sold_price, 0) > 0;

  v_gross := v_rev - v_fees - v_cogs;
  RAISE NOTICE '== clean 2026 sales ==';
  RAISE NOTICE '  % units | revenue % | fees % | cogs % | GROSS profit % (% per unit)',
    v_units, round(v_rev, 2), round(v_fees, 2), round(v_cogs, 2),
    round(v_gross, 2), round(v_gross / NULLIF(v_units, 0), 2);

  -- how many units actually came back
  SELECT COALESCE(sum(refund_quantity), 0) INTO v_ref_parent
  FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND';

  SELECT COALESCE(sum(GREATEST(COALESCE(refund_quantity, 0), quantity)), 0) INTO v_ref_rows
  FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false AND order_id LIKE '%-REFUND';

  SELECT COALESCE(sum(p.refund_quantity), 0) INTO v_ref_both
  FROM public.sales_orders rr
  JOIN public.sales_orders p
    ON p.user_id = rr.user_id AND p.order_id = replace(rr.order_id, '-REFUND', '')
  WHERE rr.user_id = v_uid AND rr.asin = 'B0CKJNCZLY'
    AND rr.order_id LIKE '%-REFUND' AND rr.order_date >= '2026-01-01'
    AND COALESCE(p.refund_quantity, 0) > 0;

  v_ref_total := v_ref_parent + v_ref_rows - v_ref_both;

  RAISE NOTICE '';
  RAISE NOTICE '== returned units ==';
  RAISE NOTICE '  on parent orders % | as -REFUND rows % | counted in both % | TOTAL %',
    v_ref_parent, v_ref_rows, v_ref_both, v_ref_total;
  RAISE NOTICE '  return rate on 2026 units: % pct',
    round(100.0 * v_ref_total / NULLIF(v_units, 0), 1);

  -- per-unit fee components, from the orders themselves
  SELECT round(avg(fba_fee / NULLIF(quantity, 0))::numeric, 2),
         round(avg(referral_fee / NULLIF(quantity, 0))::numeric, 2)
    INTO v_fba_unit, v_ref_fee_unit
  FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    AND COALESCE(fba_fee, 0) > 0;

  v_admin := LEAST(5.00, 0.20 * v_ref_fee_unit);
  SELECT unit_cost INTO v_cog FROM public.asin_cog_for_repricer
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY';

  v_ret_cost := v_ref_total * (v_fba_unit + v_admin);
  v_net_resold := v_gross - v_ret_cost;
  v_net_writeoff := v_net_resold - (v_ref_total * v_cog);

  RAISE NOTICE '';
  RAISE NOTICE '== cost of a return, per unit ==';
  RAISE NOTICE '  FBA fee kept by Amazon % | admin retention % | COG at risk %',
    v_fba_unit, round(v_admin, 2), v_cog;
  RAISE NOTICE '  so a return costs % if the unit is resold, % if written off',
    round(v_fba_unit + v_admin, 2), round(v_fba_unit + v_admin + v_cog, 2);

  RAISE NOTICE '';
  RAISE NOTICE '== 2026 RESULT, corrected ==';
  RAISE NOTICE '  gross profit            %', round(v_gross, 2);
  RAISE NOTICE '  less cost of % returns  -%', v_ref_total, round(v_ret_cost, 2);
  RAISE NOTICE '  NET if returns resold    % -> ROI % pct',
    round(v_net_resold, 2), round(100 * v_net_resold / NULLIF(v_cogs, 0), 1);
  RAISE NOTICE '  NET if returns written off % -> ROI % pct',
    round(v_net_writeoff, 2), round(100 * v_net_writeoff / NULLIF(v_cogs, 0), 1);
  RAISE NOTICE '';
  RAISE NOTICE '  (for contrast, the figure I quoted earlier: 119.03 -> 4.6 pct)';

  RAISE NOTICE '';
  RAISE NOTICE '== MONTHLY return rate, counting returns from BOTH places ==';
  RAISE NOTICE '   (parent refund_quantity + -REFUND rows, deduplicated)';
  BEGIN
    FOR r IN
      WITH sold AS (
        SELECT date_trunc('month', order_date) AS m, sum(quantity) AS units
        FROM public.sales_orders
        WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
          AND COALESCE(is_cancelled, false) = false
          AND order_id NOT LIKE '%-REFUND' AND COALESCE(sold_price, 0) > 0
        GROUP BY 1),
      ret AS (
        SELECT date_trunc('month', order_date) AS m,
               sum(CASE WHEN order_id LIKE '%-REFUND'
                        THEN GREATEST(COALESCE(refund_quantity, 0), quantity)
                        ELSE COALESCE(refund_quantity, 0) END) AS units
        FROM public.sales_orders
        WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
          AND COALESCE(is_cancelled, false) = false
        GROUP BY 1)
      SELECT to_char(COALESCE(s.m, t.m), 'YYYY-MM') AS mon,
             COALESCE(s.units, 0) AS sold_units,
             COALESCE(t.units, 0) AS ret_units,
             round((100.0 * COALESCE(t.units, 0) / NULLIF(s.units, 0))::numeric, 1) AS rate
      FROM sold s FULL JOIN ret t ON t.m = s.m
      ORDER BY 1
    LOOP
      RAISE NOTICE '  % | sold % | returned % | % pct', r.mon, r.sold_units, r.ret_units, COALESCE(r.rate::text, 'n/a');
    END LOOP;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '== did returns come back SELLABLE? (inventory_dispositions) ==';
  -- columns are total_qty / sellable_qty / unsellable_qty / returned_to_inventory_qty,
  -- not "quantity" -- which is the whole question here: how much came back usable.
  FOR r IN SELECT disposition_type, count(*) AS rows,
                  sum(COALESCE(total_qty, 0)) AS total_qty,
                  sum(COALESCE(sellable_qty, 0)) AS sellable,
                  sum(COALESCE(unsellable_qty, 0)) AS unsellable,
                  sum(COALESCE(returned_to_inventory_qty, 0)) AS back_in_stock,
                  min(disposition_date) AS first, max(disposition_date) AS last
           FROM public.inventory_dispositions
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
           GROUP BY 1 ORDER BY 3 DESC LOOP
    RAISE NOTICE '  % | % rows | total % | sellable % | unsellable % | back in stock % | % .. %',
      r.disposition_type, r.rows, r.total_qty, r.sellable, r.unsellable, r.back_in_stock, r.first, r.last;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no disposition rows for this ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== does the cached refund feed carry a reason? (keys only) ==';
  FOR r IN SELECT jsonb_object_keys(e) AS k
           FROM public.live_refunds_cache c,
                LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.refunds) = 'array' THEN c.refunds ELSE '[]'::jsonb END) e
           WHERE c.user_id = v_uid
           GROUP BY 1 ORDER BY 1 LIMIT 30 LOOP
    RAISE NOTICE '  %', r.k;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no refund rows cached)'; END IF;
END
$p$;
