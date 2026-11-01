-- WHY THE EXISTING REPAIR SWEEP CANNOT FIND THESE -- READ ONLY. 2026 ONLY.
--
-- collapsed_order_candidates (20260909050000) is the shortlist the repair cron
-- works from, and its predicate is:
--
--     AND s.quantity = 1
--     AND abs(s.fba_fee / p.unit_fee - round(...)) <= 0.08
--     AND round(s.fba_fee / p.unit_fee) >= 2
--
-- Two consequences worth measuring before proposing anything:
--
--   1. quantity = 1 ONLY. A row collapsed from 3 items to one holding
--      quantity 10 is invisible to the sweep forever, however often it runs.
--   2. the signal is an FBA FEE RATIO, which the function's own header admits
--      is weak -- "1,722 rows exceed 1.6x that ratio but only 444 land near a
--      whole number, and the rest is ordinary FBA fee variance". Amazon's
--      posted MONEY divided by our unit price is a much stronger signal, and
--      it is already in financial_events_cache.
--
-- Also checked: whether any of these orders were already checked against
-- GetOrderItems and recorded 'already_correct', which would be a direct
-- contradiction between Amazon's order data and Amazon's money data.
DO $p$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  CREATE TEMP TABLE cand ON COMMIT DROP AS
  WITH so AS (
    SELECT s.id, s.order_id, s.asin, s.sku, s.order_date, s.quantity AS stored_qty,
           s.sold_price, s.unit_cost AS snapshot_cost, s.fba_fee
    FROM public.sales_orders s
    WHERE s.user_id = v_uid
      AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND upper(COALESCE(s.marketplace,'US')) IN ('US','UNKNOWN')
      AND COALESCE(s.sold_price,0) > 0
  ),
  one_line AS (SELECT order_id FROM so GROUP BY order_id HAVING count(*) = 1),
  fec AS (
    SELECT amazon_order_id AS order_id,
           round(sum(abs(COALESCE(sales,0))),2) AS amz_money
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      AND event_type = 'shipment' AND amazon_order_id IS NOT NULL
    GROUP BY amazon_order_id
  )
  SELECT so.id, so.order_id, so.asin, so.order_date, so.stored_qty, so.fba_fee,
         round(f.amz_money / so.sold_price)    AS implied_qty,
         rc.unit_cost                          AS resolved_cost
  FROM so
  JOIN one_line ol ON ol.order_id = so.order_id
  JOIN fec f       ON f.order_id  = so.order_id
  CROSS JOIN LATERAL public.resolve_unit_cost_v1(
    v_uid, so.asin, so.sku, so.order_date, so.snapshot_cost) rc
  WHERE f.amz_money / so.sold_price > so.stored_qty + 0.5
    AND abs(f.amz_money / so.sold_price
            - round(f.amz_money / so.sold_price)) <= 0.02;

  SELECT count(*) INTO v_n FROM cand;
  RAISE NOTICE '== % confident collapsed orders, 2026 ==', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. THE BLIND SPOT: stored quantity of the collapsed rows ==';
  RAISE NOTICE '   stored qty | orders | missing units | COGS effect | sweep sees it?';
  FOR r IN
    SELECT CASE WHEN stored_qty = 1 THEN '1' ELSE '2 or more' END AS q,
           count(*) AS n, sum(implied_qty - stored_qty) AS units,
           round(sum((implied_qty - stored_qty) * COALESCE(resolved_cost,0)),2) AS cogs
    FROM cand GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | % | %', rpad(r.q,10), lpad(r.n::text,6),
      lpad(r.units::text,13), lpad(r.cogs::text,11),
      CASE WHEN r.q = '1' THEN 'yes (if the fee ratio also fires)'
           ELSE '>>> NO -- quantity = 1 excludes it' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. of the quantity = 1 rows, does the FEE RATIO also fire? ==';
  RAISE NOTICE '   the sweep needs BOTH conditions, so this is what it can reach';
  FOR r IN
    WITH per_unit AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee) AS unit_fee
      FROM public.sales_orders
      WHERE user_id = v_uid AND quantity = 1 AND COALESCE(fba_fee,0) > 0
      GROUP BY asin HAVING count(*) >= 3
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE p.unit_fee IS NULL) AS no_fee_baseline,
           count(*) FILTER (WHERE p.unit_fee > 0
             AND abs(c.fba_fee / p.unit_fee - round((c.fba_fee/p.unit_fee)::numeric)) <= 0.08
             AND round((c.fba_fee/p.unit_fee)::numeric) >= 2) AS ratio_fires
    FROM cand c LEFT JOIN per_unit p ON p.asin = c.asin
    WHERE c.stored_qty = 1
  LOOP
    RAISE NOTICE '   quantity=1 collapsed rows      : %', r.n;
    RAISE NOTICE '   no per-ASIN fee baseline (<3)  : %', r.no_fee_baseline;
    RAISE NOTICE '   fee ratio also fires           : % <= all the sweep can find',
      r.ratio_fires;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. has any of them already been checked against Amazon? ==';
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='collapsed_order_checks') THEN
    FOR r IN
      SELECT COALESCE(k.outcome,'(never checked)') AS outcome, count(*) AS n
      FROM cand c
      LEFT JOIN public.collapsed_order_checks k ON k.sales_order_id = c.id
      GROUP BY 1 ORDER BY 2 DESC
    LOOP
      RAISE NOTICE '   % | % orders | %', rpad(r.outcome,18), lpad(r.n::text,5),
        CASE WHEN r.outcome = 'already_correct'
             THEN '>>> CONTRADICTION: GetOrderItems said correct, the money says not'
             WHEN r.outcome = 'repaired' THEN 'repaired yet still short -- re-collapsed since'
             WHEN r.outcome = '(never checked)' THEN 'the sweep has never reached it'
             ELSE '' END;
    END LOOP;
    SELECT count(*) INTO v_n FROM public.collapsed_order_checks WHERE user_id = v_uid;
    RAISE NOTICE '   (the checks table holds % rows in total)', v_n;
    FOR r IN
      SELECT outcome, count(*) AS n FROM public.collapsed_order_checks
      WHERE user_id = v_uid GROUP BY 1 ORDER BY 2 DESC
    LOOP RAISE NOTICE '      all-time: % | %', rpad(r.outcome,18), r.n; END LOOP;
  ELSE
    RAISE NOTICE '   collapsed_order_checks does not exist -- sweep never deployed';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, no API called.';
END
$p$;
