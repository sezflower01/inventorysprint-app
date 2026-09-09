-- PROBE (read-only): my own 1.6x threshold is too loose and I should not have
-- quoted 123 as "likely collapses".
--
-- A genuine collapse means the fees were charged for N whole units while the
-- revenue kept 1, so fba_fee / per_unit_fee must land near an INTEGER >= 2.
-- The candidate list is full of 1.73, 1.80, 2.38, 2.21 -- fractional ratios,
-- which is ordinary FBA fee variance for an ASIN (size-tier reclassification,
-- fee schedule changes, peak surcharges), not a collapse.
--
-- Re-measure with the integer test, and separately with a signal that does not
-- depend on fee medians at all.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== integer test: how many land near a whole number? ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    ),
    ratios AS (
      SELECT s.order_id, s.asin, s.order_date, s.total_sale_amount,
             s.fba_fee / p.unit_fee AS implied
      FROM public.sales_orders s
      JOIN per_unit p ON p.asin = s.asin
      WHERE s.user_id = v_uid AND s.quantity = 1
        AND p.unit_fee > 0 AND s.fba_fee / p.unit_fee > 1.6
        AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
    )
    SELECT
      count(*) AS all_over_1_6,
      count(*) FILTER (WHERE abs(implied - round(implied)) <= 0.08 AND round(implied) >= 2) AS near_integer,
      count(*) FILTER (WHERE abs(implied - round(implied)) <= 0.08 AND round(implied) >= 2
                         AND order_date > now() - interval '90 days') AS near_integer_90d
    FROM ratios
  LOOP
    RAISE NOTICE '   % rows exceed 1.6x   <- what I called "likely collapses"', r.all_over_1_6;
    RAISE NOTICE '   % of those sit within 0.08 of a whole number >= 2', r.near_integer;
    RAISE NOTICE '   % of THOSE are in the last 90 days', r.near_integer_90d;
    RAISE NOTICE '   -> the rest is ordinary FBA fee variance, not a collapse';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the near-integer rows, last 180 days ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT s.order_id, s.asin, s.order_date, s.total_sale_amount, s.fba_fee,
           round(p.unit_fee::numeric,2) AS unit_fee,
           round((s.fba_fee / p.unit_fee)::numeric, 3) AS implied,
           s.order_status
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1
      AND p.unit_fee > 0
      AND abs(s.fba_fee / p.unit_fee - round((s.fba_fee / p.unit_fee)::numeric)) <= 0.08
      AND round((s.fba_fee / p.unit_fee)::numeric) >= 2
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
      AND s.order_date > now() - interval '180 days'
    ORDER BY s.order_date DESC LIMIT 30
  LOOP
    RAISE NOTICE '   % | % | % | rev=% fba=% (unit %) -> % units | %',
      r.order_date, r.order_id, r.asin,
      round(r.total_sale_amount::numeric,2), round(r.fba_fee::numeric,2),
      r.unit_fee, r.implied, r.order_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== independent check: referral fee vs 15%% of revenue ========';
  -- Referral is a flat percentage of the order principal, so a collapsed row
  -- shows referral_fee well above 15% of its own recorded revenue. This does
  -- not rely on fee medians at all, so it is a genuinely separate signal.
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE order_date > now() - interval '90 days') AS d90
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity = 1
      AND COALESCE(total_sale_amount,0) > 0
      AND COALESCE(referral_fee,0) / total_sale_amount > 0.25
      AND COALESCE(order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   % qty=1 rows carry referral above 25%% of their own revenue (% in 90d)',
      r.n, r.d90;
    RAISE NOTICE '   (Amazon referral is ~15%%; well above that means the fee was';
    RAISE NOTICE '    charged on more revenue than the row records)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== rows failing BOTH tests -- the confident set ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE s.order_date > now() - interval '90 days') AS d90,
           round(sum(s.total_sale_amount)::numeric,2) AS rev_now
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1
      AND p.unit_fee > 0
      AND abs(s.fba_fee / p.unit_fee - round((s.fba_fee / p.unit_fee)::numeric)) <= 0.08
      AND round((s.fba_fee / p.unit_fee)::numeric) >= 2
      AND COALESCE(s.total_sale_amount,0) > 0
      AND COALESCE(s.referral_fee,0) / s.total_sale_amount > 0.25
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
  LOOP
    RAISE NOTICE '   % rows fail the integer test AND the referral test (% in 90d)',
      r.n, r.d90;
    RAISE NOTICE '   revenue currently recorded on them: %', r.rev_now;
  END LOOP;
END
$probe$;
