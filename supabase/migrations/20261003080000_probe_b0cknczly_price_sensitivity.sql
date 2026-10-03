-- READ-ONLY PROBE. What does a new buy of B0CKJNCZLY actually earn at today's
-- price, with 2026's volume and 2026's returns held constant?
--
-- Fee structure is taken from asin_fee_cache (US), not assumed: referral is a
-- RATE so it shrinks with price, while fba_fee_fixed does not. That asymmetry
-- is the whole story -- a $1.93 price cut costs about $1.64 of profit, because
-- only the referral share of the fee falls with it.
--
-- Return cost per unit SOLD is the 2026 experience spread over 2026 volume:
-- 94 returns x (FBA fee kept + min($5, 20% x referral)) / 465 units. It does
-- not shrink when the price falls, which is why a lower price is punished twice.

DO $p$
DECLARE
  v_uid uuid; r record;
  v_cog numeric; v_fba numeric; v_rate numeric;
  v_units int := 465; v_returns int := 94; v_cogs_total numeric;
  v_admin numeric; v_ret_unit numeric; v_ret_per_sold numeric;
  v_avg_price numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT fba_fee_fixed, referral_rate INTO v_fba, v_rate
  FROM public.asin_fee_cache
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND marketplace = 'US' LIMIT 1;

  SELECT unit_cost INTO v_cog FROM public.asin_cog_for_repricer
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY';

  SELECT round((sum(COALESCE(total_sale_amount, sold_price * quantity)) / NULLIF(sum(quantity), 0))::numeric, 2)
    INTO v_avg_price
  FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    AND COALESCE(sold_price, 0) > 0;

  v_cogs_total := v_cog * v_units;
  RAISE NOTICE 'fee structure from cache: referral % pct + FBA $% fixed | COG $% | 2026 avg price $%',
    round(100 * v_rate, 2), round(v_fba, 2), v_cog, v_avg_price;

  RAISE NOTICE '';
  RAISE NOTICE '== ROI by selling price, 465 units and 94 returns held constant ==';
  FOR r IN
    SELECT p AS price,
           round((p * v_rate)::numeric, 2) AS referral,
           round((p * v_rate + v_fba)::numeric, 2) AS fees,
           round((p - p * v_rate - v_fba - v_cog)::numeric, 2) AS gross_unit,
           round((100 * (p - p * v_rate - v_fba - v_cog) / v_cog)::numeric, 1) AS gross_roi,
           round((v_returns * (v_fba + LEAST(5.00, 0.20 * p * v_rate)) / v_units)::numeric, 2) AS ret_per_sold,
           round((p - p * v_rate - v_fba - v_cog
                  - v_returns * (v_fba + LEAST(5.00, 0.20 * p * v_rate)) / v_units)::numeric, 2) AS net_unit,
           round((100 * (p - p * v_rate - v_fba - v_cog
                  - v_returns * (v_fba + LEAST(5.00, 0.20 * p * v_rate)) / v_units) / v_cog)::numeric, 1) AS net_roi
    FROM (VALUES (20.00), (18.13), (17.00), (16.20), (15.00), (14.00)) AS t(p)
    ORDER BY p DESC
  LOOP
    RAISE NOTICE '  $% | fees $% | gross $%/u (% pct) | returns -$%/u | NET $%/u -> % pct',
      r.price, r.fees, r.gross_unit, r.gross_roi, r.ret_per_sold, r.net_unit, r.net_roi;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what a lower COG (rewards, better buy price) does at $16.20 ==';
  FOR r IN
    SELECT c AS cost,
           round((16.20 - 16.20 * v_rate - v_fba - c)::numeric, 2) AS gross_unit,
           round((16.20 - 16.20 * v_rate - v_fba - c
                  - v_returns * (v_fba + LEAST(5.00, 0.20 * 16.20 * v_rate)) / v_units)::numeric, 2) AS net_unit,
           round((100 * (16.20 - 16.20 * v_rate - v_fba - c
                  - v_returns * (v_fba + LEAST(5.00, 0.20 * 16.20 * v_rate)) / v_units) / c)::numeric, 1) AS net_roi
    FROM (VALUES (v_cog), (v_cog * 0.95), (v_cog * 0.90), (v_cog * 0.85)) AS t(c)
    ORDER BY c DESC
  LOOP
    RAISE NOTICE '  COG $% | gross $%/u | NET $%/u -> % pct', round(r.cost, 2), r.gross_unit, r.net_unit, r.net_roi;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is $16.20 holding? our realised price by month ==';
  FOR r IN SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS mon,
                  sum(quantity) AS units,
                  round((sum(COALESCE(total_sale_amount, sold_price * quantity)) / NULLIF(sum(quantity), 0))::numeric, 2) AS avg_price
           FROM public.sales_orders
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND order_date >= '2026-04-01'
             AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
             AND COALESCE(sold_price, 0) > 0
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % | % units | avg $%', r.mon, r.units, r.avg_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== competition: recent snapshots ==';
  FOR r IN SELECT date_trunc('day', created_at) AS d,
                  round(min(lowest_overall_price)::numeric, 2) AS lowest,
                  round(min(lowest_fba_price)::numeric, 2) AS lowest_fba,
                  round(min(buybox_price)::numeric, 2) AS buybox,
                  count(*) AS snaps
           FROM public.repricer_competitor_snapshots
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND created_at > now() - interval '14 days'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % | lowest overall $% | lowest FBA $% | buybox $% | % snapshots',
      r.d, r.lowest, r.lowest_fba, r.buybox, r.snaps;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no snapshots in 14 days)'; END IF;
END
$p$;
