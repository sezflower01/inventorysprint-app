-- Stage-2 ground truth, READ-ONLY. The report table is not the authority on
-- what is applied -- January was applied before persistReport existed, so it
-- has no report row at all, and the status board showed no 2026-05 either.
-- The authority is the data: a month with clawbacks stored has been applied.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== financial_events_cache: the date column, read not guessed ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache'
      AND (data_type LIKE '%date%' OR data_type LIKE '%timestamp%')
  LOOP RAISE NOTICE '   date-ish columns: %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2026 by month: clawbacks stored = already applied ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           count(*) AS adj_rows,
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) <> 0) AS claw_rows,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw_total
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % adjustment rows | % clawback rows | clawbacks %',
      r.m, lpad(r.adj_rows::text,5), lpad(r.claw_rows::text,4), lpad(r.claw_total::text,10);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== dry runs on file, and the catch-all gate for each ==';
  FOR r IN
    SELECT left(month,7) AS m, count(*) AS runs,
           min((report->>'api_items_via_catchall')::int) AS min_ca,
           max((report->>'api_items_via_catchall')::int) AS max_ca,
           max((report->>'api_signed_total')::numeric) AS api_total,
           max((report->>'stored_signed_total')::numeric) AS stored_total,
           max((report->>'api_clawback_total')::numeric) AS claw,
           to_char(max(captured_at),'MM-DD HH24:MI') AS last_run
    FROM public.repull_reports
    WHERE report ? 'api_signed_total' AND applied = false
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % runs | catch-all % .. % | api % vs stored % | clawbacks % | last %',
      r.m, r.runs, r.min_ca, r.max_ca, lpad(r.api_total::text,9),
      lpad(r.stored_total::text,9), lpad(COALESCE(r.claw::text,'-'),9), r.last_run;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the stage-2 total: clawbacks waiting to be booked ==';
  FOR r IN
    SELECT round(sum(claw)::numeric,2) AS total, count(*) AS months, string_agg(m, ', ' ORDER BY m) AS which
    FROM (
      SELECT left(month,7) AS m, max((report->>'api_clawback_total')::numeric) AS claw
      FROM public.repull_reports
      WHERE report ? 'api_clawback_total' AND applied = false
      GROUP BY 1
    ) z
    WHERE claw <> 0
  LOOP
    RAISE NOTICE '   % across % months: %', r.total, r.months, r.which;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== months with NO dry run on file (still need one) ==';
  FOR r IN
    SELECT to_char(d,'YYYY-MM') AS m
    FROM generate_series('2026-01-01'::date,'2026-09-01'::date,'1 month') d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.repull_reports rr
      WHERE left(rr.month,7) = to_char(d,'YYYY-MM') AND rr.report ? 'api_signed_total')
    ORDER BY 1
  LOOP RAISE NOTICE '   %', r.m; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none -- every month Jan..Sep has a dry run'; END IF;
END
$p$;
