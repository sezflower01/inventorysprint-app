-- A P&L baseline that can actually fail.
--
-- pl_baseline_20261022 was captured by calling get_monthly_pl_breakdown(2026)
-- straight from a migration. That RPC is scoped WHERE f.user_id = auth.uid(),
-- and auth.uid() is NULL for the postgres role that runs migrations, so the
-- table it produced is 480 cells and every one of them is zero. Comparing the
-- live P&L against it compares zeros with zeros: it reported all twelve months
-- identical even for the four whose clawbacks were applied after 10-22. Same
-- class of defect as the db-lint gate that was green on noop: a check that
-- cannot fail.
--
-- auth.uid() reads the request.jwt.claims GUC that PostgREST sets per request,
-- so set_config(..., is_local => true) reproduces the UI auth context for the
-- rest of THIS transaction. Proved in 20261030100000: 0 of 480 non-zero cells
-- before, 299 of 480 after.
--
-- DELIBERATELY NOT A FUNCTION. The obvious convenience -- a public
-- pl_live_as_user(uid, year) wrapper -- would be an RLS bypass: every
-- user-facing table scopes by auth.uid(), so a callable function that sets that
-- GUC to an arbitrary uid would let any authenticated caller read any other
-- seller's financials. The impersonation stays inside migration DO blocks,
-- where the role is already postgres and already sees everything. July onward
-- repeats these four lines rather than calling a helper.
DROP TABLE IF EXISTS public.pl_baseline_20261030;
CREATE TABLE public.pl_baseline_20261030 (
  month_num integer PRIMARY KEY,
  pl        jsonb   NOT NULL,
  taken_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pl_baseline_20261030 ENABLE ROW LEVEL SECURITY;

DO $p$
DECLARE r record; v_uid uuid; v_months int; v_sales numeric; v_nonzero int;
        v_old numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- refusing to capture a baseline of zeros';
  END IF;

  INSERT INTO public.pl_baseline_20261030 (month_num, pl)
  SELECT (to_jsonb(l) ->> 'month_num')::integer, to_jsonb(l) - 'month_num'
  FROM public.get_monthly_pl_breakdown(2026) l;

  SELECT count(*), COALESCE(sum((pl->>'sales')::numeric),0)
    INTO v_months, v_sales FROM public.pl_baseline_20261030;
  SELECT count(*) INTO v_nonzero
  FROM public.pl_baseline_20261030 b, LATERAL jsonb_each_text(b.pl) AS e(k,v)
  WHERE v NOT IN ('0','0.00') AND v IS NOT NULL;

  RAISE NOTICE '== pl_baseline_20261030 ==';
  RAISE NOTICE '   months % | non-zero cells % | 2026 sales %',
    v_months, v_nonzero, round(v_sales,2);

  IF v_months <> 12 THEN
    RAISE EXCEPTION 'baseline has % month rows, expected 12', v_months;
  END IF;
  IF v_sales <= 0 THEN
    RAISE EXCEPTION 'baseline sales total is % -- no auth context, useless', v_sales;
  END IF;
  IF v_nonzero = 0 THEN
    RAISE EXCEPTION 'baseline is entirely zeros -- the 10-22 failure, repeated';
  END IF;
  RAISE NOTICE '   GATE PASSED: 12 months, non-empty, real sales';

  RAISE NOTICE '';
  RAISE NOTICE '== what it recorded ==';
  FOR r IN
    SELECT month_num AS m,
           round((pl->>'sales')::numeric,2) AS sales,
           round((pl->>'refunds')::numeric,2) AS refunds,
           round((pl->>'compensated_clawback')::numeric,2) AS claw
    FROM public.pl_baseline_20261030 ORDER BY month_num
  LOOP
    RAISE NOTICE '   m% | sales % | refunds % | clawback %',
      lpad(r.m::text,2), lpad(r.sales::text,12), lpad(r.refunds::text,11),
      lpad(r.claw::text,9);
  END LOOP;

  SELECT COALESCE(sum(sales),0) INTO v_old FROM public.pl_baseline_20261022;
  RAISE NOTICE '   for contrast, pl_baseline_20261022 sales total: %',
    round(v_old::numeric,2);

  RAISE NOTICE '';
  RAISE NOTICE '== MAY AND JUNE IN THE P&L LINE ITSELF ==';
  FOR r IN
    SELECT month_num AS m, round((pl->>'compensated_clawback')::numeric,2) AS claw
    FROM public.pl_baseline_20261030 WHERE month_num IN (5,6) ORDER BY 1
  LOOP
    RAISE NOTICE '   m% compensated_clawback % | %',
      r.m, lpad(r.claw::text,8),
      CASE WHEN (r.m = 5 AND r.claw = 187.96) OR (r.m = 6 AND r.claw = 209.69)
           THEN 'PRESENT, matches the applied amount'
           ELSE 'MISSING -- investigate' END;
  END LOOP;
  RAISE NOTICE '   the RPC returns a positive magnitude; plModel EXPENSE_ROWS';
  RAISE NOTICE '   subtracts it, so 187.96 here is -187.96 of profit';

  RAISE NOTICE '';
  RAISE NOTICE '== does the RPC clawback line agree with the table? ==';
  FOR r IN
    SELECT b.month_num AS m,
           round((b.pl->>'compensated_clawback')::numeric,2) AS rpc_claw,
           round(COALESCE(adj.claw,0)::numeric,2) AS tbl_adj,
           round(COALESCE(allt.claw,0)::numeric,2) AS tbl_all
    FROM public.pl_baseline_20261030 b
    LEFT JOIN (
      SELECT extract(month FROM event_date)::int AS m, sum(compensated_clawback) AS claw
      FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type = 'adjustment'
        AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      GROUP BY 1) adj ON adj.m = b.month_num
    LEFT JOIN (
      SELECT extract(month FROM event_date)::int AS m, sum(compensated_clawback) AS claw
      FROM public.financial_events_cache
      WHERE user_id = v_uid
        AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      GROUP BY 1) allt ON allt.m = b.month_num
    WHERE COALESCE((b.pl->>'compensated_clawback')::numeric,0) <> 0
       OR COALESCE(allt.claw,0) <> 0
    ORDER BY 1
  LOOP
    RAISE NOTICE '   m% | RPC % | adjustment rows % | ALL rows % | %',
      lpad(r.m::text,2), lpad(r.rpc_claw::text,9), lpad(r.tbl_adj::text,10),
      lpad(r.tbl_all::text,10),
      CASE WHEN r.rpc_claw = -r.tbl_all THEN 'agrees with ALL rows'
           WHEN r.rpc_claw = -r.tbl_adj THEN 'agrees with adjustment rows only'
           ELSE 'MISMATCH -- look at this' END;
  END LOOP;
END
$p$;
