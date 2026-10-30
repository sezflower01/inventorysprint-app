-- READ-ONLY. Check 6 of the June verification reported all twelve 2026 months
-- IDENTICAL to pl_baseline_20261022 -- including January, May, June and
-- October, every one of which has had clawbacks applied since that baseline was
-- taken on 2026-10-22.
--
-- That cannot be right as a clawback check. Either get_monthly_pl_breakdown
-- does not surface compensated_clawback at all, or it lands in a column the
-- baseline does not carry. Until that is settled, check 6 proves only "nothing
-- ELSE in the P&L moved" -- a useful negative control, but NOT evidence that
-- the clawbacks reached the P&L.
--
-- This matters beyond the gate: the whole purpose of the re-pull is to get these
-- amounts into the P&L, and an accountant is about to be told May's profit fell
-- by $187.96.
DO $p$
DECLARE r record; v_uid uuid; v_key text; v_has boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== columns get_monthly_pl_breakdown(2026) returns ==';
  FOR r IN
    SELECT string_agg(k, ', ' ORDER BY k) AS cols
    FROM (SELECT jsonb_object_keys(to_jsonb(l)) AS k
          FROM public.get_monthly_pl_breakdown(2026) l LIMIT 1) s
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  SELECT EXISTS (
    SELECT 1 FROM (SELECT jsonb_object_keys(to_jsonb(l)) AS k
                   FROM public.get_monthly_pl_breakdown(2026) l LIMIT 1) s
    WHERE k ILIKE '%clawback%' OR k ILIKE '%compensat%'
  ) INTO v_has;
  RAISE NOTICE '   a clawback-ish column present: %', v_has;

  RAISE NOTICE '';
  RAISE NOTICE '== does the baseline carry the same columns? ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY column_name) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pl_baseline_20261022'
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== June and May side by side, live vs baseline, every column ==';
  FOR r IN
    SELECT l.month_num AS m, to_jsonb(l) AS live, to_jsonb(b) AS base
    FROM public.get_monthly_pl_breakdown(2026) l
    JOIN public.pl_baseline_20261022 b ON b.month_num = l.month_num
    WHERE l.month_num IN (5,6) ORDER BY 1
  LOOP
    RAISE NOTICE '   -- month % --', r.m;
    FOR v_key IN SELECT k FROM jsonb_object_keys(r.base) k ORDER BY 1 LOOP
      RAISE NOTICE '      % base % | live % | %',
        rpad(v_key,28), lpad(COALESCE(r.base->>v_key,'-'),13),
        lpad(COALESCE(r.live->>v_key,'-'),13),
        CASE WHEN COALESCE(r.live->>v_key,'~') = COALESCE(r.base->>v_key,'~')
             THEN 'same' ELSE '<-- MOVED' END;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== where DO the clawbacks sit in financial_events_cache? ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) <> 0) AS claw_rows,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw,
           round(COALESCE(sum(sales),0)::numeric,2)   AS sales,
           round(COALESCE(sum(refunds),0)::numeric,2) AS refunds
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-05-01' AND event_date < '2026-07-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows carry a clawback | claw % | sales in adj % | refunds in adj %',
      r.m, lpad(r.claw_rows::text,4), lpad(r.claw::text,10),
      lpad(r.sales::text,10), lpad(r.refunds::text,10);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is compensated_clawback referenced by the P&L RPCs at all? ==';
  FOR r IN
    SELECT p.proname,
           (pg_get_functiondef(p.oid) ILIKE '%compensated_clawback%') AS mentions_claw
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('get_monthly_pl_breakdown','get_monthly_cogs','get_pl_summary')
    ORDER BY 1
  LOOP RAISE NOTICE '   % | mentions compensated_clawback: %', rpad(r.proname,28), r.mentions_claw; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every public function whose body mentions compensated_clawback ==';
  FOR r IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND pg_get_functiondef(p.oid) ILIKE '%compensated_clawback%'
    ORDER BY 1
  LOOP RAISE NOTICE '   %', r.proname; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE -- no database function reads that column'; END IF;
END
$p$;
