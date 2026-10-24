-- MY BUG, in two places, and it cost the whole of stage 1.
--
-- repull_reports.month holds whatever the writer put there, and the two writers
-- disagree: the edge function persists the request's month string
-- ('2026-06-01'), while repull_month_adjustments_apply returns
-- to_char(start,'YYYY-MM') ('2026-06'). Both my settle logic and the residual
-- explainer matched on the SECOND form only.
--
-- So June ran FIVE times, each run persisted a perfectly good report, and the
-- driver found none of them -- marked the month failed after 3 attempts and
-- unscheduled itself. The explainer likewise reported "no dry-run report with a
-- multiset" for February, March and April while the data was sitting there.
--
-- Nothing was written and nothing was lost; the cost was time. Matching on the
-- first seven characters accepts both forms, and a comment on the column records
-- why the format is not assumed.
COMMENT ON COLUMN public.repull_reports.month IS
  'Month label as written by whichever producer persisted the row: the edge function writes YYYY-MM-01, repull_month_adjustments_apply writes YYYY-MM. Match on left(month,7), never on equality with one form.';

CREATE OR REPLACE FUNCTION public.repull_find_report(p_month date, p_applied boolean DEFAULT NULL,
                                                     p_since timestamptz DEFAULT NULL,
                                                     p_need_multiset boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT report FROM public.repull_reports
  WHERE left(month, 7) = to_char(date_trunc('month', p_month), 'YYYY-MM')
    AND (p_applied IS NULL OR applied = p_applied)
    AND (p_since IS NULL OR captured_at >= p_since)
    AND (NOT p_need_multiset OR report ? 'api_amount_multiset')
  ORDER BY captured_at DESC LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_find_report(date, boolean, timestamptz, boolean) TO service_role;
