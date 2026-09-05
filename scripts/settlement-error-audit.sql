-- Settlement report error audit
--
-- Run in the Supabase SQL Editor (project mstibdszibcheodvnprm).
--
-- Context: on 2026-09-05 the Settlement Reports dialog showed ~29 rows with
-- status 'error', $0.00 and 0 lines, all with periods between 2026-01-28 and
-- 2026-03-10. The UI shows the status but not the reason -- the reason is in
-- settlement_reports.error_message, which nothing renders.
--
-- Re-syncing cannot revisit these. sync-settlement-reports clamps its Amazon
-- discovery window to the last 90 days:
--
--   const effectiveFrom = fromDate < retentionStartDate ? retentionStartDate : fromDate;
--
-- so a "Sync 2026 Settlements" today asks Amazon only about 2026-06-07 onward
-- and never re-requests a February report. These queries are therefore a
-- post-mortem, not a prelude to a retry.

-- 1. WHY did they fail? One row per distinct message.
select
  error_message,
  count(*)                          as reports,
  min(settlement_start_date)        as earliest_period,
  max(settlement_end_date)          as latest_period
from public.settlement_reports
where status = 'error'
group by error_message
order by reports desc;

-- 2. The failed reports in full, newest first.
select
  amazon_report_id,
  marketplace,
  marketplace_id,
  settlement_start_date,
  settlement_end_date,
  amazon_report_document_id is not null as had_document_id,
  created_at,
  error_message
from public.settlement_reports
where status = 'error'
order by settlement_start_date desc;

-- 3. Which calendar days actually have PARSED settlement coverage?
--    A day missing here is a day the reconciliation cross-check cannot see.
--    (The P&L itself is unaffected -- get_monthly_pl_breakdown reads only
--    financial_events_cache and never touches settlement data.)
select
  date_trunc('month', settlement_start_date)::date as month,
  count(*) filter (where status = 'parsed')        as parsed,
  count(*) filter (where status = 'error')          as errored,
  sum(rows_parsed) filter (where status = 'parsed') as line_items,
  min(settlement_start_date) filter (where status = 'parsed') as first_covered,
  max(settlement_end_date)   filter (where status = 'parsed') as last_covered
from public.settlement_reports
group by 1
order by 1;

-- 4. Are any failures inside the window Amazon can still serve?
--    Anything returned here IS worth re-syncing; anything older is gone.
select
  amazon_report_id,
  settlement_start_date,
  settlement_end_date,
  error_message
from public.settlement_reports
where status = 'error'
  and created_at >= now() - interval '90 days'
order by settlement_start_date desc;
