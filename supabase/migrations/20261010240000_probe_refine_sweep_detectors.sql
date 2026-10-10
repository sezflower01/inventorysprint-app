-- READ-ONLY. Two corrections before anything is proposed.
--
-- B WAS A BAD DETECTOR. It LEFT JOINed the parent and treated a missing parent
-- as zero units, so every refund whose parent order is simply absent from
-- sales_orders got flagged -- 3,507 rows "claiming" 3,699 units against parents
-- totalling 3, and the ten worst all read "(no parent row)". A refund with no
-- parent is a DIFFERENT problem (the creation path missed the order), not a
-- phantom refund. Restricting to refunds whose parent exists is the honest test.
--
-- A NEEDS A LIVENESS CHECK. 282 orders carry a squared figure worth $25,475.53
-- and Amazon agrees with total_sale_amount on 282 of 282. Whether that is
-- VISIBLE depends on whether any consumer computes sold_price * quantity:
-- getConfirmedSalesOrderRevenueUsd prefers total_sale_amount when present, so
-- the error may be latent -- real in the column, invisible on screen.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== B corrected: refunds whose parent EXISTS and shipped fewer units ==';
  FOR r IN
    SELECT count(*) AS refund_rows, sum(ref.quantity) AS claimed,
           sum(par.quantity) AS parent_units,
           sum(ref.quantity - par.quantity) AS phantom_units
    FROM public.sales_orders ref
    JOIN public.sales_orders par
      ON par.user_id = ref.user_id
     AND par.order_id = regexp_replace(ref.order_id, '-REFUND(-\d+)?$', '')
     AND par.asin = ref.asin
    WHERE ref.user_id = v_uid AND ref.order_id LIKE '%-REFUND%'
      AND ref.quantity > par.quantity
  LOOP
    RAISE NOTICE '  % rows | % units claimed | % shipped by parents | % phantom',
      r.refund_rows, r.claimed, r.parent_units, r.phantom_units;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none -- no refund exceeds a parent that exists)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== refunds with NO parent row at all (a separate problem) ==';
  FOR r IN
    SELECT count(*) AS orphans, sum(ref.quantity) AS units,
           min(ref.order_date) AS oldest, max(ref.order_date) AS newest
    FROM public.sales_orders ref
    WHERE ref.user_id = v_uid AND ref.order_id LIKE '%-REFUND%'
      AND NOT EXISTS (SELECT 1 FROM public.sales_orders par
                      WHERE par.user_id = ref.user_id
                        AND par.order_id = regexp_replace(ref.order_id,'-REFUND(-\d+)?$','')
                        AND par.asin = ref.asin)
  LOOP
    RAISE NOTICE '  % refund rows have no parent | % units | % .. %',
      r.orphans, r.units, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== A liveness: is the squared figure actually SHOWN? ==';
  FOR r IN
    SELECT count(*) AS squared_rows,
           round(sum(total_sale_amount)::numeric,2) AS line_total_sum,
           round(sum(sold_price * quantity)::numeric,2) AS squared_sum
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(is_cancelled,false)=false
      AND order_id NOT LIKE '%-REFUND%' AND quantity > 1
      AND COALESCE(total_sale_amount,0) > 0
      AND abs(sold_price - total_sale_amount) < 0.005
  LOOP
    RAISE NOTICE '  % rows', r.squared_rows;
    RAISE NOTICE '  consumers preferring total_sale_amount see $%', r.line_total_sum;
    RAISE NOTICE '  consumers computing sold_price x qty see  $%', r.squared_sum;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN
    SELECT (pg_get_functiondef(p.oid) ILIKE '%total_sale_amount%') AS uses_line_total,
           (pg_get_functiondef(p.oid) ILIKE '%sold_price%') AS uses_sold_price
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='get_asin_profit'
  LOOP
    RAISE NOTICE '  get_asin_profit mentions total_sale_amount %, sold_price %',
      r.uses_line_total, r.uses_sold_price;
  END LOOP;
END
$p$;
