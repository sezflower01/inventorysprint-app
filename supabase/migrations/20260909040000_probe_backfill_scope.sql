-- PROBE (read-only): before repairing anything, two questions.
--
--   1. Has 111-8310672-6833058 corrected itself yet? A browser sync or the
--      settlement path would have done it, and that is the evidence the fix
--      works before it is applied to 123 more rows.
--   2. Exactly which orders would a repair touch, and what would change?
--
-- The repair cannot be done in SQL: the truth is Amazon's OrderItems, which
-- only an SP-API call can read. This sizes the job and names the rows.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== has the original corrected itself? ========';
  FOR r IN
    SELECT quantity, total_sale_amount, total_fees, order_status,
           price_source, updated_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '111-8310672-6833058'
  LOOP
    RAISE NOTICE '   quantity=%  revenue=%  fees=%  status=%',
      r.quantity, r.total_sale_amount, r.total_fees, r.order_status;
    RAISE NOTICE '   price_source=%  updated=%', r.price_source, r.updated_at;
    IF r.quantity = 3 THEN
      RAISE NOTICE '   -> CORRECTED (3 units)';
    ELSE
      RAISE NOTICE '   -> still % unit(s); no sync has re-read it yet', r.quantity;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the repair candidates, last 90 days ========';
  -- qty=1 rows whose FBA fee is well above the median per-unit fee for their
  -- own ASIN. That ratio is the estimate of how many units the fees were
  -- actually charged for.
  FOR r IN
    WITH per_unit AS (
      SELECT asin,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee,
             count(*) AS samples
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT s.order_id, s.asin, s.quantity, s.total_sale_amount, s.fba_fee,
           round(p.unit_fee::numeric, 2) AS unit_fee,
           round((s.fba_fee / p.unit_fee)::numeric, 2) AS implied_units,
           s.order_status, s.order_date
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1
      AND p.unit_fee > 0 AND s.fba_fee / p.unit_fee > 1.6
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
      AND s.order_date > now() - interval '90 days'
    ORDER BY s.order_date DESC LIMIT 25
  LOOP
    RAISE NOTICE '   % | % | % | qty=% rev=% fba=% (unit %) -> implies % units',
      r.order_date, r.order_id, r.asin, r.quantity, r.total_sale_amount,
      r.fba_fee, r.unit_fee, r.implied_units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== totals for the 90-day repair set ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT count(*) AS n,
           count(DISTINCT s.order_id) AS orders,
           round(sum(s.total_sale_amount)::numeric, 2) AS revenue_now,
           round(sum(s.total_sale_amount * (s.fba_fee / p.unit_fee))::numeric, 2) AS revenue_if_repaired,
           round(sum(s.fba_fee)::numeric, 2) AS fees
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1
      AND p.unit_fee > 0 AND s.fba_fee / p.unit_fee > 1.6
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
      AND s.order_date > now() - interval '90 days'
  LOOP
    RAISE NOTICE '   % rows across % orders', r.n, r.orders;
    RAISE NOTICE '   revenue recorded now      : %', r.revenue_now;
    RAISE NOTICE '   revenue if the estimate holds: %  <- ESTIMATE ONLY', r.revenue_if_repaired;
    RAISE NOTICE '   understated by roughly    : %', r.revenue_if_repaired - r.revenue_now;
    RAISE NOTICE '   (Amazon OrderItems is the only source that can confirm this)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many are settled vs still pending? ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT COALESCE(s.order_status,'(null)') AS st, count(*) AS n
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1
      AND p.unit_fee > 0 AND s.fba_fee / p.unit_fee > 1.6
      AND s.order_date > now() - interval '90 days'
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   status=%  : % rows', rpad(r.st,14), r.n;
  END LOOP;
END
$probe$;
