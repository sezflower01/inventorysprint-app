-- Finish the repair: the stored ROI was left stale.
--
-- I corrected revenue to 49.98 but not the derived ROI, which still read
-- -49.2% -- computed when revenue was 24.99 against a 24.64 cost. The row
-- therefore still showed a loss on a profitable sale, which is the number a
-- person actually looks at.
--
--   revenue 49.98 - cost 24.64 - fees 12.47 = 12.87 profit
--   12.87 / 24.64 = 52.2%
--
-- Backed up already by sales_orders_price_repair_20261025, taken before the
-- first write.
UPDATE public.sales_orders
   SET roi = round((((total_sale_amount - total_cost - total_fees)
                     / NULLIF(total_cost,0)) * 100)::numeric, 2),
       updated_at = now()
 WHERE order_id = '113-1305212-7465044'
   AND round(total_sale_amount,2) = 49.98
   AND total_cost > 0;

DO $p$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT quantity AS q, round(sold_price,2) AS unit_px,
           round(total_sale_amount,2) AS revenue, round(total_cost,2) AS cost,
           round(total_fees,2) AS fees, round(roi,1) AS roi, price_source AS src
    FROM public.sales_orders WHERE order_id='113-1305212-7465044'
  LOOP
    RAISE NOTICE '== 113-1305212-7465044, repaired ==';
    RAISE NOTICE '   qty % | unit % | revenue % | cost % | fees % | ROI % | source %',
      r.q, r.unit_px, r.revenue, r.cost, r.fees, r.roi, r.src;
    IF r.roi < 0 THEN RAISE EXCEPTION 'ROI still negative: %', r.roi; END IF;
  END LOOP;
END
$p$;
