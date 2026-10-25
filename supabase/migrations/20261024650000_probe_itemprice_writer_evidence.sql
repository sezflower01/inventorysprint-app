-- READ-ONLY. Two things: the surviving evidence of what Amazon sent, and a
-- recount that does NOT depend on estimated_price.
--
-- The writer is reconcile-pending-prices/index.ts:
--     const itemPrice = parseFloat(item.ItemPrice.Amount);   // 220
--     const qty       = item.QuantityOrdered || 1;           // 223
--     const perUnit   = itemPrice / qty;                     // 224  UNROUNDED
--     sold_price: perUnit, total_sale_amount: itemPrice,     // 241/243
--     estimated_price: 0,                                    // 246  wipes the cross-check
--
-- 24.99 / 2 = 12.495 unrounded, which is exactly what the row stores, so this
-- is the writer beyond doubt. It also explains the NULL estimate: the writer
-- erases it, which is what blinds the lowball guard.
--
-- keepa_estimate_accuracy records keepa_estimate and actual_price (= perUnit)
-- at the moment of the write, so it preserves the estimate the writer
-- destroyed -- and with it, what ItemPrice must have been.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== accuracy log for the two suspect orders ==';
  FOR r IN
    SELECT order_id, asin, round(keepa_estimate,2) AS est_before,
           round(actual_price,4) AS per_unit_written, flagged,
           COALESCE(notes,'') AS notes, order_date
    FROM public.keepa_estimate_accuracy
    WHERE order_id IN ('113-1305212-7465044','114-8141058-0108255')
    ORDER BY order_date DESC
  LOOP
    RAISE NOTICE '   % | % | estimate before % | perUnit written % | flagged % | %',
      r.order_id, r.asin, r.est_before, r.per_unit_written, r.flagged, r.notes;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no accuracy rows for either order'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== accuracy rows where the written unit price is ~half the estimate ==';
  RAISE NOTICE '   (the signature of dividing a per-unit ItemPrice by quantity)';
  FOR r IN
    SELECT order_id, asin, round(keepa_estimate,2) AS est,
           round(actual_price,4) AS written,
           round((keepa_estimate / NULLIF(actual_price,0))::numeric,2) AS ratio,
           order_date
    FROM public.keepa_estimate_accuracy
    WHERE user_id = v_uid AND order_date >= current_date - 60
      AND actual_price > 0 AND keepa_estimate > 0
      AND keepa_estimate / actual_price >= 1.8
    ORDER BY order_date DESC LIMIT 20
  LOOP
    RAISE NOTICE '   % | % | est % | written % | ratio %x | %',
      r.order_id, r.asin, lpad(r.est::text,8), lpad(r.written::text,9),
      lpad(r.ratio::text,6), r.order_date;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ RECOUNT, no reliance on estimated_price ############';
  RAISE NOTICE '== every multi-unit orders_itemprice row, last 60d, by status ==';
  FOR r IN
    SELECT COALESCE(order_status,'(null)') AS st, count(*) AS n,
           count(*) FILTER (WHERE abs(total_sale_amount - sold_price*quantity) < 0.011) AS consistent,
           count(*) FILTER (WHERE estimated_price IS NULL OR estimated_price = 0) AS est_wiped,
           count(*) FILTER (WHERE sold_price < unit_cost) AS below_cost
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 60
      AND quantity > 1 AND price_source LIKE 'orders_itemprice%'
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % | % rows | % internally consistent | % with estimate wiped | % below cost',
      rpad(r.st,10), lpad(r.n::text,4), lpad(r.consistent::text,4),
      lpad(r.est_wiped::text,4), r.below_cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== of those, how many does settlement later disagree with? ==';
  RAISE NOTICE '   (settled rows carry price_source financial_events, so a still-';
  RAISE NOTICE '    orders_itemprice row has never been corrected)';
  FOR r IN
    SELECT count(*) FILTER (WHERE lower(COALESCE(order_status,''))='pending') AS still_pending,
           count(*) FILTER (WHERE lower(COALESCE(order_status,''))<>'pending') AS moved_on,
           count(*) AS total
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= current_date - 60
      AND quantity > 1 AND price_source LIKE 'orders_itemprice%'
  LOOP
    RAISE NOTICE '   % rows total | % still Pending | % moved past Pending but never re-sourced',
      r.total, r.still_pending, r.moved_on;
  END LOOP;
END
$p$;
