-- PROBE (read-only): the near-integer rows split into TWO different failures,
-- and the referral test separates them. This matters because they have opposite
-- effects on reported profit and need different repairs.
--
--   Class A -- revenue understated (a true collapse).
--     Revenue kept one item's value, fees cover N units. referral_fee is well
--     above 15% of the recorded revenue because it was charged on more.
--     Example B07FN34L97: rev 7.89, referral 3.54 = 45% of 7.89.
--     Effect: profit understated. This is what the seller reported.
--
--   Class B -- quantity understated only.
--     Revenue already holds the full line total, quantity says 1.
--     referral sits at a normal ~15%.
--     Example B0GXMMZ6ZY: rev 22.13, fba implies 2 units, so 22.13 is two
--     units of revenue recorded against a quantity of 1.
--     Effect: total_cost = unit_cost x 1 instead of x 2, so COGS is halved and
--     profit is OVERSTATED. The opposite direction, and invisible on screen.
--
-- Size class B and its cost impact.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== the two classes ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    ),
    near AS (
      SELECT s.*, round((s.fba_fee / p.unit_fee)::numeric) AS units
      FROM public.sales_orders s
      JOIN per_unit p ON p.asin = s.asin
      WHERE s.user_id = v_uid AND s.quantity = 1 AND p.unit_fee > 0
        AND abs(s.fba_fee / p.unit_fee - round((s.fba_fee / p.unit_fee)::numeric)) <= 0.08
        AND round((s.fba_fee / p.unit_fee)::numeric) >= 2
        AND COALESCE(s.total_sale_amount,0) > 0
        AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
    )
    SELECT
      count(*) FILTER (WHERE referral_fee / total_sale_amount > 0.25) AS class_a,
      count(*) FILTER (WHERE referral_fee / total_sale_amount <= 0.25) AS class_b,
      count(*) AS total
    FROM near
  LOOP
    RAISE NOTICE '   class A, revenue understated : % rows', r.class_a;
    RAISE NOTICE '   class B, quantity only       : % rows', r.class_b;
    RAISE NOTICE '   total near-integer            : % rows', r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== class B: what the missing quantity costs in COGS ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    ),
    near AS (
      SELECT s.*, round((s.fba_fee / p.unit_fee)::numeric) AS units
      FROM public.sales_orders s
      JOIN per_unit p ON p.asin = s.asin
      WHERE s.user_id = v_uid AND s.quantity = 1 AND p.unit_fee > 0
        AND abs(s.fba_fee / p.unit_fee - round((s.fba_fee / p.unit_fee)::numeric)) <= 0.08
        AND round((s.fba_fee / p.unit_fee)::numeric) >= 2
        AND COALESCE(s.total_sale_amount,0) > 0
        AND COALESCE(s.referral_fee,0) / s.total_sale_amount <= 0.25
        AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE order_date > now() - interval '90 days') AS d90,
           round(sum(total_sale_amount)::numeric,2) AS revenue,
           round(sum(COALESCE(total_cost,0))::numeric,2) AS cogs_now,
           round(sum(COALESCE(unit_cost,0) * units)::numeric,2) AS cogs_if_repaired,
           round(sum(units)::numeric,0) AS true_units
    FROM near
  LOOP
    RAISE NOTICE '   % rows (% in the last 90 days), % units really sold',
      r.n, r.d90, r.true_units;
    RAISE NOTICE '   revenue recorded    : %', r.revenue;
    RAISE NOTICE '   COGS recorded       : %', r.cogs_now;
    RAISE NOTICE '   COGS if quantity fixed: %', r.cogs_if_repaired;
    RAISE NOTICE '   profit OVERSTATED by roughly: %', r.cogs_if_repaired - r.cogs_now;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== class A: the confident revenue-understated rows ========';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT s.order_id, s.asin, s.order_date,
           round(s.total_sale_amount::numeric,2) AS rev,
           round(s.referral_fee::numeric,2) AS referral,
           round((s.referral_fee / s.total_sale_amount * 100)::numeric,0) AS referral_pct,
           round((s.fba_fee / p.unit_fee)::numeric) AS units
    FROM public.sales_orders s
    JOIN per_unit p ON p.asin = s.asin
    WHERE s.user_id = v_uid AND s.quantity = 1 AND p.unit_fee > 0
      AND abs(s.fba_fee / p.unit_fee - round((s.fba_fee / p.unit_fee)::numeric)) <= 0.08
      AND round((s.fba_fee / p.unit_fee)::numeric) >= 2
      AND COALESCE(s.total_sale_amount,0) > 0
      AND COALESCE(s.referral_fee,0) / s.total_sale_amount > 0.25
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
    ORDER BY s.order_date DESC
  LOOP
    RAISE NOTICE '   % | % | % | rev=% referral=% (%%%) -> % units',
      r.order_date, r.order_id, r.asin, r.rev, r.referral, r.referral_pct, r.units;
  END LOOP;
END
$probe$;
