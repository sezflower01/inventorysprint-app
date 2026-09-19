-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller asks for an average "according to what sold" on the COG page row
-- for B00A6W0HEQ (COG $4.97, latest purchase 400 x $4.55 on Sep 15,
-- 131 sold in 2026 costed $6.15). Show the lots and the candidate averages.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT unit_cost, source, calculated_cost, calculation, price_change_unit_cost, price_change_units, updated_at
           FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B00A6W0HEQ' LOOP
    RAISE NOTICE 'COG % (%), calculated %, price_change % x %, updated %', r.unit_cost, r.source, r.calculated_cost,
      r.price_change_unit_cost, r.price_change_units, r.updated_at;
    RAISE NOTICE 'calculation %', r.calculation;
  END LOOP;

  FOR r IN SELECT COALESCE(date_created::date, created_at::date) AS d, created_at, units, cost, amount, round((cost/NULLIF(units,0))::numeric, 2) AS unit,
                  validation_status, sku
           FROM public.created_listings WHERE user_id = v_uid AND asin = 'B00A6W0HEQ' ORDER BY created_at LOOP
    RAISE NOTICE 'LOT % (created %) | % units | cost % | amount % | unit % | % | %', r.d, to_char(r.created_at, 'YYYY-MM-DD'), r.units, r.cost, r.amount, r.unit, r.validation_status, r.sku;
  END LOOP;

  FOR r IN SELECT count(*) AS orders, sum(quantity) AS units,
                  round((sum(unit_cost_at_sale * quantity) / NULLIF(sum(quantity),0))::numeric, 2) AS avg_cost_at_sale,
                  min(order_date) AS first, max(order_date) AS last
           FROM public.sales_orders WHERE user_id = v_uid AND asin = 'B00A6W0HEQ' AND COALESCE(is_cancelled,false) = false
             AND order_date >= '2026-01-01' LOOP
    RAISE NOTICE 'SOLD 2026: % orders, % units, avg cost at sale %, % .. %', r.orders, r.units, r.avg_cost_at_sale, r.first, r.last;
  END LOOP;

  FOR r IN SELECT sum(COALESCE(available,0)) av, sum(COALESCE(reserved,0)) res, sum(COALESCE(inbound,0)) inb
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B00A6W0HEQ' LOOP
    RAISE NOTICE 'STOCK now: available % reserved % inbound %', r.av, r.res, r.inb;
  END LOOP;
END
$p$;
