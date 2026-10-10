-- READ-ONLY PROBE 2 of 3. The squared-revenue sweep and the phantom refunds.
--
-- Both were identified in earlier sessions and have been waiting for approval.
-- This re-derives each set from scratch rather than trusting the old counts,
-- states the check that proves each row wrong, and prices the correction.
-- Nothing is applied.
--
-- SQUARED REVENUE. sold_price is contracted to be the UNIT price and
-- total_sale_amount the line total. When a writer puts the line total into
-- sold_price, any consumer computing sold_price * quantity squares the revenue
-- by the quantity. The tell is sold_price = total_sale_amount on a row with
-- quantity > 1: a genuine multi-unit line cannot have those equal unless the
-- unit price happens to equal the whole line, which only holds at quantity 1.
--
-- PHANTOM REFUNDS. A return cannot exceed the units its ORDER shipped. A
-- -REFUND row claiming more units than its parent is not a refund that
-- happened; it is a counting error, and it inflates the return rate that
-- every reorder decision rests on.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- ── A. squared revenue ────────────────────────────────────────────────────
  RAISE NOTICE '== A1. rows where sold_price equals total_sale_amount AND quantity > 1 ==';
  FOR r IN
    SELECT count(*) AS orders, sum(quantity) AS units,
           round(sum(sold_price * quantity - total_sale_amount)::numeric, 2) AS overstated,
           min(order_date) AS oldest, max(order_date) AS newest
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
      AND quantity > 1
      AND COALESCE(total_sale_amount,0) > 0
      AND abs(sold_price - total_sale_amount) < 0.005
  LOOP
    RAISE NOTICE '  % orders | % units | $% overstated | % .. %',
      r.orders, r.units, r.overstated, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== A2. by quantity, so the shape is visible ==';
  FOR r IN
    SELECT quantity, count(*) AS orders,
           round(avg(sold_price)::numeric,2) AS unit_price_field,
           round(avg(total_sale_amount)::numeric,2) AS line_total_field,
           round(sum(sold_price * quantity - total_sale_amount)::numeric,2) AS overstated
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(is_cancelled,false)=false
      AND order_id NOT LIKE '%-REFUND%' AND quantity > 1
      AND COALESCE(total_sale_amount,0) > 0
      AND abs(sold_price - total_sale_amount) < 0.005
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  qty % | % orders | sold_price $% = total_sale_amount $% | $% overstated',
      lpad(r.quantity::text,3), lpad(r.orders::text,5), lpad(r.unit_price_field::text,8),
      lpad(r.line_total_field::text,8), r.overstated;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== A3. does the financial event agree with the line total? (the proof) ==';
  FOR r IN
    SELECT count(*) AS checked,
           count(*) FILTER (WHERE abs(fe.sales - so.total_sale_amount) < 0.51) AS fe_matches_line_total,
           count(*) FILTER (WHERE abs(fe.sales - so.sold_price * so.quantity) < 0.51) AS fe_matches_squared
    FROM public.sales_orders so
    JOIN (SELECT amazon_order_id, sum(sales) AS sales
          FROM public.financial_events_cache WHERE user_id = v_uid AND sales > 0
          GROUP BY 1) fe ON fe.amazon_order_id = so.order_id
    WHERE so.user_id = v_uid AND COALESCE(so.is_cancelled,false)=false
      AND so.order_id NOT LIKE '%-REFUND%' AND so.quantity > 1
      AND COALESCE(so.total_sale_amount,0) > 0
      AND abs(so.sold_price - so.total_sale_amount) < 0.005
  LOOP
    RAISE NOTICE '  % of these have a financial event', r.checked;
    RAISE NOTICE '    Amazon agrees with total_sale_amount : %  <- line total is right',
      r.fe_matches_line_total;
    RAISE NOTICE '    Amazon agrees with sold_price x qty  : %  <- squared figure is right',
      r.fe_matches_squared;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== A4. the ten largest ==';
  FOR r IN
    SELECT order_id, asin, quantity, sold_price, total_sale_amount,
           round((sold_price * quantity - total_sale_amount)::numeric,2) AS overstated, order_date
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(is_cancelled,false)=false
      AND order_id NOT LIKE '%-REFUND%' AND quantity > 1
      AND COALESCE(total_sale_amount,0) > 0
      AND abs(sold_price - total_sale_amount) < 0.005
    ORDER BY (sold_price * quantity - total_sale_amount) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | % | q% | sold_price $% | line $% | +$% | %',
      r.order_id, r.asin, r.quantity, lpad(r.sold_price::text,8),
      lpad(r.total_sale_amount::text,8), lpad(r.overstated::text,8), r.order_date;
  END LOOP;

  -- ── B. phantom refunds ────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '== B1. -REFUND rows claiming more units than the parent order shipped ==';
  FOR r IN
    SELECT count(*) AS refund_rows,
           sum(ref.quantity) AS claimed_units,
           sum(COALESCE(par.quantity,0)) AS parent_units,
           sum(ref.quantity - COALESCE(par.quantity,0)) AS phantom_units
    FROM public.sales_orders ref
    LEFT JOIN public.sales_orders par
      ON par.user_id = ref.user_id
     AND par.order_id = regexp_replace(ref.order_id, '-REFUND(-\d+)?$', '')
     AND par.asin = ref.asin
    WHERE ref.user_id = v_uid AND ref.order_id LIKE '%-REFUND%'
      AND ref.quantity > COALESCE(par.quantity, 0)
  LOOP
    RAISE NOTICE '  % refund rows | % units claimed | % units the parents shipped | % phantom',
      r.refund_rows, r.claimed_units, r.parent_units, r.phantom_units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B2. the ten worst, with the parent for comparison ==';
  FOR r IN
    SELECT ref.order_id, ref.asin, ref.quantity AS refund_qty,
           COALESCE(par.quantity,0) AS parent_qty,
           COALESCE(par.order_id,'(no parent row)') AS parent_order,
           ref.order_date
    FROM public.sales_orders ref
    LEFT JOIN public.sales_orders par
      ON par.user_id = ref.user_id
     AND par.order_id = regexp_replace(ref.order_id, '-REFUND(-\d+)?$', '')
     AND par.asin = ref.asin
    WHERE ref.user_id = v_uid AND ref.order_id LIKE '%-REFUND%'
      AND ref.quantity > COALESCE(par.quantity,0)
    ORDER BY (ref.quantity - COALESCE(par.quantity,0)) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | % | refund claims % vs parent % | % | %',
      rpad(r.order_id,26), r.asin, lpad(r.refund_qty::text,4),
      lpad(r.parent_qty::text,4), rpad(r.parent_order,22), r.order_date;
  END LOOP;
END
$p$;
