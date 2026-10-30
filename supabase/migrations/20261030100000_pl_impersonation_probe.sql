-- READ-ONLY. Can a migration read the REAL P&L the UI sees?
--
-- pl_baseline_20261022 is 480 zero cells because get_monthly_pl_breakdown is
-- scoped `WHERE f.user_id = auth.uid()` and auth.uid() is NULL for the
-- `postgres` role that runs migrations. Verified 2026-10-30.
--
-- auth.uid() is not magic: it reads the `request.jwt.claims` GUC that PostgREST
-- sets per request. If set_config() can populate that GUC for the duration of
-- THIS transaction, the RPC returns the signed-in user's real figures and a
-- baseline captured here is worth something. This probe establishes whether it
-- works before anything is written, so the capture migration cannot fail and
-- block the queue.
DO $p$
DECLARE r record; v_uid uuid; v_nonzero int; v_cells int; v_sales numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== 1. how auth.uid() is actually defined ==';
  FOR r IN
    SELECT regexp_replace(pg_get_functiondef(p.oid), E'\s+', ' ', 'g') AS d
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='auth' AND p.proname='uid'
  LOOP RAISE NOTICE '   %', left(r.d, 400); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. before impersonation ==';
  RAISE NOTICE '   current_user % | auth.uid() %', current_user,
    COALESCE((SELECT auth.uid())::text,'NULL');
  SELECT count(*) FILTER (WHERE v NOT IN ('0','0.00') AND v IS NOT NULL), count(*)
    INTO v_nonzero, v_cells
  FROM public.get_monthly_pl_breakdown(2026) l,
       LATERAL jsonb_each_text(to_jsonb(l) - 'month_num') AS e(k,v);
  RAISE NOTICE '   non-zero cells: % of %', v_nonzero, v_cells;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. impersonate the signed-in user for this transaction ==';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  RAISE NOTICE '   auth.uid() now %', COALESCE((SELECT auth.uid())::text,'NULL');
  RAISE NOTICE '   matches the real uid: %', ((SELECT auth.uid()) = v_uid);

  SELECT count(*) FILTER (WHERE v NOT IN ('0','0.00') AND v IS NOT NULL), count(*)
    INTO v_nonzero, v_cells
  FROM public.get_monthly_pl_breakdown(2026) l,
       LATERAL jsonb_each_text(to_jsonb(l) - 'month_num') AS e(k,v);
  RAISE NOTICE '   non-zero cells: % of %', v_nonzero, v_cells;
  IF v_nonzero = 0 THEN
    RAISE NOTICE '   >>> STILL ZEROS -- impersonation does not work, need another route';
  ELSE
    RAISE NOTICE '   >>> REAL DATA. A baseline captured this way is meaningful.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. every column the RPC returns ==';
  FOR r IN
    SELECT string_agg(k, ', ' ORDER BY k) AS cols
    FROM (SELECT to_jsonb(l) AS j FROM public.get_monthly_pl_breakdown(2026) l LIMIT 1) one,
         jsonb_object_keys(one.j) AS k
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. sales and clawback per month, from the RPC the UI calls ==';
  FOR r IN
    SELECT month_num AS m, round(sales::numeric,2) AS sales,
           round(compensated_clawback::numeric,2) AS claw,
           round(refunds::numeric,2) AS refunds
    FROM public.get_monthly_pl_breakdown(2026) ORDER BY month_num
  LOOP
    RAISE NOTICE '   m% | sales % | refunds % | compensated_clawback %',
      lpad(r.m::text,2), lpad(r.sales::text,12), lpad(r.refunds::text,11),
      lpad(r.claw::text,10);
  END LOOP;

  SELECT COALESCE(sum(sales),0) INTO v_sales FROM public.get_monthly_pl_breakdown(2026);
  RAISE NOTICE '   total 2026 sales from the RPC: %', round(v_sales::numeric,2);
  RAISE NOTICE '';
  RAISE NOTICE '   expected: m5 clawback 187.96, m6 clawback 209.69 (ABSed to a';
  RAISE NOTICE '   positive magnitude -- plModel EXPENSE_ROWS subtracts it)';
END
$p$;
