-- CLOSING THE PHANTOM-FEE BOUND -- READ ONLY. 2026 ONLY.
--
-- 20261031131000 measured the phantom on KNOWN-MFN rows: 68 rows, 242.45. But
-- 10 rows with a NULL fulfillment_channel also carry BOTH a label fee and an
-- fba_fee, and a seller-paid label is the very signal the 2026-10-19 rule-A
-- backfill used to prove MFN. Those 10 are almost certainly MFN as well, just
-- posted after the backfill ran -- so the phantom is 242.45 PLUS whatever they
-- hold. Quantifying it is the difference between a figure and a lower bound.
DO $p$
DECLARE r record; v_uid uuid; v_rows int; v_fba numeric; v_label numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*), round(sum(COALESCE(fba_fee,0))::numeric,2),
         round(sum(COALESCE(shipping_label_fee,0))::numeric,2)
    INTO v_rows, v_fba, v_label
  FROM public.sales_orders
  WHERE user_id = v_uid
    AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
    AND order_id NOT LIKE '%-REFUND%'
    AND fulfillment_channel IS NULL
    AND COALESCE(shipping_label_fee,0) > 0 AND COALESCE(fba_fee,0) > 0;

  RAISE NOTICE '== NULL-channel 2026 rows carrying BOTH a label fee and an fba_fee ==';
  RAISE NOTICE '   rows % | fba_fee % | label_fee %', v_rows, COALESCE(v_fba,0),
    COALESCE(v_label,0);
  RAISE NOTICE '   TOTAL 2026 PHANTOM fba_fee = 242.45 (known MFN) + % = %',
    COALESCE(v_fba,0), round(242.45 + COALESCE(v_fba,0),2);

  RAISE NOTICE '';
  RAISE NOTICE '   the rows themselves:';
  FOR r IN
    SELECT order_id, order_date, asin,
           round(COALESCE(fba_fee,0)::numeric,2) AS fba,
           round(COALESCE(shipping_label_fee,0)::numeric,2) AS label,
           COALESCE(fees_source,'-') AS fsrc
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
      AND fulfillment_channel IS NULL
      AND COALESCE(shipping_label_fee,0) > 0 AND COALESCE(fba_fee,0) > 0
    ORDER BY order_date
  LOOP
    RAISE NOTICE '      % | % | % | fba % | label % | %', r.order_id, r.order_date,
      rpad(r.asin,12), lpad(r.fba::text,6), lpad(r.label::text,6), r.fsrc;
  END LOOP;

  ------------------------------------------------------------------
  -- while here: size item 3 WITHOUT calling Amazon.
  -- The settled-quantity check needs SP-API. What it does NOT need is
  -- SP-API to find the candidates, or to show how exposed COGS is.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '== 2026 multi-unit orders: the population item 3 would sample ==';
  RAISE NOTICE '   quantity | orders | units |   revenue |  COGS exposure';
  FOR r IN
    SELECT CASE WHEN quantity >= 5 THEN '5+' ELSE quantity::text END AS q,
           count(*) AS orders, sum(quantity) AS units,
           round(sum(COALESCE(sold_price,0))::numeric,2) AS rev
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
      AND COALESCE(quantity,0) >= 2
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | %', lpad(r.q,8), lpad(r.orders::text,6),
      lpad(r.units::text,5), lpad(r.rev::text,9);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no multi-unit 2026 orders)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   why it matters: COGS = quantity x unit cost, so a wrong';
  RAISE NOTICE '   quantity mis-states COGS directly and proportionally.';
  FOR r IN
    SELECT count(*) AS multi_orders,
           sum(quantity) AS multi_units,
           (SELECT sum(quantity) FROM public.sales_orders
             WHERE user_id = v_uid AND order_date >= '2026-01-01'
               AND order_date < '2027-01-01' AND order_id NOT LIKE '%-REFUND%')
             AS all_units
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
      AND COALESCE(quantity,0) >= 2
  LOOP
    RAISE NOTICE '   multi-unit orders % holding % of % total 2026 units (% pct)',
      r.multi_orders, r.multi_units, r.all_units,
      round(100.0 * r.multi_units / greatest(r.all_units,1),1);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, no API called.';
END
$p$;
