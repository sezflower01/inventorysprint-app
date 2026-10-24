-- Stage 1 review: did all five dry runs finish, is job 196 gone, and what do
-- the February, March and April residuals actually consist of?
--
-- repull_residual_explain is re-pointed at public.repull_reports rather than
-- net._http_response. The latter is purged in batches -- every request id read
-- earlier in this exercise has already vanished from it -- so an explainer that
-- depends on it would work once and then silently stop finding anything.

CREATE OR REPLACE FUNCTION public.repull_residual_explain(
  p_user uuid, p_month date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_body jsonb; v_ms jsonb; r record; v_col text;
  v_api numeric; v_stored numeric; v_claw numeric; v_resid numeric;
  v_cols text[] := ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                         'free_replacement_refund_items','compensated_clawback',
                         'reimbursements','fbm_shipping_label_fee'];
BEGIN
  -- Newest DRY-RUN report for the month that actually carries a multiset.
  SELECT report INTO v_body FROM public.repull_reports
  WHERE month = to_char(v_start,'YYYY-MM')
    AND applied = false
    AND report ? 'api_amount_multiset'
  ORDER BY captured_at DESC LIMIT 1;

  RAISE NOTICE '';
  RAISE NOTICE '======== % ========', to_char(v_start,'YYYY-MM');
  IF v_body IS NULL THEN
    RAISE NOTICE '   no dry-run report with a multiset for this month';
    RETURN;
  END IF;

  v_api    := (v_body->>'api_signed_total')::numeric;
  v_stored := (v_body->>'stored_signed_total')::numeric;
  v_claw   := (v_body->>'api_clawback_total')::numeric;
  v_resid  := round((v_api - v_stored) - v_claw, 2);
  RAISE NOTICE '   API signed % | stored signed % | predicted change %',
    v_api, v_stored, round(v_api - v_stored, 2);
  RAISE NOTICE '   clawback % | RESIDUAL %', v_claw, v_resid;

  v_ms := v_body->'api_amount_multiset';

  -- THE GATE: a non-empty reimbursements multiset means the catch-all fired,
  -- i.e. an AdjustmentType with no column of its own.
  IF jsonb_array_length(COALESCE(v_ms->'reimbursements','[]'::jsonb)) > 0 THEN
    RAISE NOTICE '   >>> UNMAPPED TYPE: % rows went to the catch-all (reimbursements)',
      jsonb_array_length(v_ms->'reimbursements');
    RAISE NOTICE '       amounts: %', v_ms->'reimbursements';
    RAISE NOTICE '       STOP -- this needs a routing decision, not a backfill.';
  ELSE
    RAISE NOTICE '   reimbursements multiset EMPTY -> no unmapped AdjustmentType';
  END IF;

  FOREACH v_col IN ARRAY v_cols LOOP
    CONTINUE WHEN jsonb_array_length(COALESCE(v_ms->v_col,'[]'::jsonb)) = 0;

    RAISE NOTICE '   -- % --', v_col;
    FOR r IN
      EXECUTE format($q$
        WITH api AS (
          SELECT round(x::numeric,2) AS amt, count(*) AS n
          FROM jsonb_array_elements_text(%L::jsonb) AS t(x) GROUP BY 1
        ), cur AS (
          SELECT round(%I,2) AS amt, count(*) AS n
          FROM public.financial_events_cache
          WHERE user_id=%L AND event_type='adjustment'
            AND event_date>=%L AND event_date<%L AND COALESCE(%I,0) <> 0
          GROUP BY 1
        )
        SELECT COALESCE(cur.amt, api.amt) AS amt,
               COALESCE(cur.n,0) AS stored_n, COALESCE(api.n,0) AS api_n
        FROM cur FULL OUTER JOIN api ON api.amt = cur.amt
        WHERE COALESCE(cur.n,0) <> COALESCE(api.n,0)
        ORDER BY 1
      $q$, COALESCE(v_ms->v_col,'[]'::jsonb)::text, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      % | stored % -> api % | %',
        lpad(r.amt::text,10), lpad(r.stored_n::text,3), lpad(r.api_n::text,3),
        CASE WHEN r.api_n > r.stored_n THEN 'appeared' ELSE 'vanished' END;
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '      multisets identical'; END IF;

    -- Two-component pairings: a vanished amount equal to the sum of two that
    -- appeared is a collision unpacking, and is money-neutral.
    FOR r IN
      EXECUTE format($q$
        WITH api AS (
          SELECT round(x::numeric,2) AS amt, count(*) AS n
          FROM jsonb_array_elements_text(%L::jsonb) AS t(x) GROUP BY 1
        ), cur AS (
          SELECT round(%I,2) AS amt, count(*) AS n
          FROM public.financial_events_cache
          WHERE user_id=%L AND event_type='adjustment'
            AND event_date>=%L AND event_date<%L AND COALESCE(%I,0) <> 0
          GROUP BY 1
        ), gone AS (
          SELECT cur.amt FROM cur LEFT JOIN api ON api.amt=cur.amt
          WHERE COALESCE(api.n,0) < cur.n
        ), app AS (
          SELECT api.amt FROM api LEFT JOIN cur ON cur.amt=api.amt
          WHERE COALESCE(cur.n,0) < api.n
        )
        SELECT g.amt AS v, a1.amt AS p1, a2.amt AS p2
        FROM gone g JOIN app a1 ON a1.amt < g.amt JOIN app a2 ON a2.amt <= a1.amt
        WHERE round(a1.amt + a2.amt, 2) = g.amt ORDER BY g.amt
      $q$, COALESCE(v_ms->v_col,'[]'::jsonb)::text, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      PAIRED % = % + %  (collision unpack, money-neutral)', r.v, r.p1, r.p2;
    END LOOP;
  END LOOP;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_residual_explain(uuid, date) TO service_role;

DO $p$
DECLARE v_uid uuid; r record; v_pending int; v_fired int; v_done int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== JOB 196 ==';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobid = 196
  LOOP RAISE NOTICE '   [%] % | % | active %', r.jobid, r.jobname, r.schedule, r.active; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   job 196 is GONE (unscheduled)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== STAGE 1 WORK LIST ==';
  FOR r IN
    SELECT seq, to_char(month,'YYYY-MM') AS m, stage, status, attempts,
           COALESCE(left(note,50),'-') AS note
    FROM public.repull_schedule ORDER BY seq
  LOOP
    RAISE NOTICE '   % | % | % | % | att % | %', r.seq, r.m, rpad(r.stage,5),
      rpad(r.status,7), r.attempts, r.note;
  END LOOP;
  SELECT count(*) FILTER (WHERE status='pending'), count(*) FILTER (WHERE status='fired'),
         count(*) FILTER (WHERE status='done')
    INTO v_pending, v_fired, v_done FROM public.repull_schedule;
  RAISE NOTICE '   pending % | fired % | done %', v_pending, v_fired, v_done;

  RAISE NOTICE '';
  RAISE NOTICE '== ALL PERSISTED REPORTS ==';
  FOR r IN
    SELECT month, applied, report->>'pages' AS pg,
           report->>'api_rows_after_dedupe' AS api, report->>'stored_rows' AS st,
           report->>'api_clawback_total' AS claw,
           round((report->>'api_signed_total')::numeric
                 - (report->>'stored_signed_total')::numeric, 2) AS pred,
           (report ? 'api_amount_multiset') AS has_ms,
           captured_at
    FROM public.repull_reports
    WHERE report ? 'api_signed_total'
    ORDER BY month, captured_at
  LOOP
    RAISE NOTICE '   % | api % | stored % | claw % | pred % | multiset % | %',
      COALESCE(r.month,'-'), lpad(COALESCE(r.api,'-'),4), lpad(COALESCE(r.st,'-'),4),
      lpad(COALESCE(r.claw,'-'),9), lpad(COALESCE(r.pred::text,'-'),9), r.has_ms,
      to_char(r.captured_at,'HH24:MI');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================ RESIDUAL EXPLANATIONS ================';
  PERFORM public.repull_residual_explain(v_uid, '2026-02-01');
  PERFORM public.repull_residual_explain(v_uid, '2026-03-01');
  PERFORM public.repull_residual_explain(v_uid, '2026-04-01');
END
$p$;
