-- DOES NET PROFIT ALREADY SUBTRACT THE FBM LABEL COST? -- READ ONLY. 2026 ONLY.
--
-- 20261031131000 found 1,199.67 of real shipping_label_fee on sales_orders
-- against 0.00 in financial_events_cache, and concluded Net Profit omits it.
-- That conclusion read plModel.ts's own comment, which says the money "has
-- simply never reached the P&L". The comment is STALE.
--
-- Migration 20260831160000 added get_monthly_fbm_label_cost, which reads
-- sales_orders directly, and the UI wires it:
--   MonthlyPLBreakdown.tsx:1110-1111  subtracts fbmLabelMonthly in BOTH views
--   ProfitLoss.tsx:1834, 2118, 2120   Excel export, row "FBM Shipping Labels"
-- So the cache column being 0.00 proves nothing about the P&L -- there are two
-- paths and only one of them is dead.
--
-- This checks the live path: what that RPC returns per month, against the raw
-- sales_orders total it is supposed to reflect.
DO $p$
DECLARE r record; v_uid uuid; v_rpc numeric := 0; v_raw numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  RAISE NOTICE '== get_monthly_fbm_label_cost(2026, NULL) ==';
  RAISE NOTICE '   month | label_cost per RPC | sales_orders raw | diff';
  FOR r IN
    SELECT l.month_num AS m, round(l.label_cost,2) AS rpc,
           round(COALESCE((
             SELECT sum(COALESCE(so.shipping_label_fee,0))
             FROM public.sales_orders so
             WHERE so.user_id = v_uid
               AND so.order_id NOT LIKE '%-REFUND%'
               AND EXTRACT(MONTH FROM so.order_date) = l.month_num
               AND so.order_date >= '2026-01-01' AND so.order_date < '2027-01-01'
           ),0)::numeric,2) AS raw
    FROM public.get_monthly_fbm_label_cost(2026, NULL) l
    ORDER BY l.month_num
  LOOP
    IF r.rpc <> 0 OR r.raw <> 0 THEN
      RAISE NOTICE '   %  | % | % | %', lpad(r.m::text,5), lpad(r.rpc::text,18),
        lpad(r.raw::text,16), lpad(round(r.raw - r.rpc,2)::text,8);
      v_rpc := v_rpc + r.rpc;
    END IF;
  END LOOP;

  SELECT round(sum(COALESCE(shipping_label_fee,0))::numeric,2) INTO v_raw
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-01-01' AND order_date < '2027-01-01';

  RAISE NOTICE '   ------------------------------------------------------';
  RAISE NOTICE '   2026 | % | % | %', lpad(round(v_rpc,2)::text,18),
    lpad(COALESCE(v_raw,0)::text,16), lpad(round(COALESCE(v_raw,0) - v_rpc,2)::text,8);

  IF round(v_rpc,2) = COALESCE(round(v_raw,2),0) AND v_rpc > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> CORRECTION: Net Profit DOES already carry this cost, in';
    RAISE NOTICE '   >>> full, via get_monthly_fbm_label_cost. The earlier finding';
    RAISE NOTICE '   >>> that 1,199.67 is missing from the P&L is WITHDRAWN.';
    RAISE NOTICE '   >>> plModel.ts''s comment saying it never reached the P&L is';
    RAISE NOTICE '   >>> stale prose, not a live defect.';
  ELSIF v_rpc = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> the RPC returns 0.00 while sales_orders holds %.', COALESCE(v_raw,0);
    RAISE NOTICE '   >>> So the cost really is absent from Net Profit.';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '   >>> the RPC and the raw table DISAGREE by %.',
      round(COALESCE(v_raw,0) - v_rpc,2);
    RAISE NOTICE '   >>> Part of the cost reaches Net Profit and part does not.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written.';
END
$p$;
