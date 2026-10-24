-- Stop the explainer crying wolf, then read AUGUST, then fire SEPTEMBER.
--
-- WHY THE EXPLAINER WAS WRONG
-- ---------------------------
-- repull_residual_explain decided "UNMAPPED TYPE ... STOP" from nothing more
-- than a non-empty reimbursements multiset:
--
--     IF jsonb_array_length(v_ms->'reimbursements') > 0 THEN ... STOP
--
-- That is precisely the false alarm this work already diagnosed once and fixed
-- in adjustment-router.ts by adding an explicit viaCatchAll flag. A NEGATIVE
-- LOST or DAMAGE amount routes to the reimbursements column BY DESIGN, with
-- viaCatchAll: false. Only the final unrecognised-AdjustmentType branch sets
-- viaCatchAll: true. The explainer was never re-pointed at the new field, so
-- it kept inferring from the old signal.
--
-- On May this made it shout "UNMAPPED TYPE: 1 rows ... amounts: [-6.83] STOP"
-- while the function's own gate in the same report read
-- api_items_via_catchall = 0 and api_catchall_types = {}. The gate is the
-- authority; -6.83 is a negative LOST/DAMAGE item sitting where it belongs.
--
-- This replaces the inference with the recorded fact. DIAGNOSTIC ONLY -- it
-- reads reports and writes nothing to financial_events_cache.
CREATE OR REPLACE FUNCTION public.repull_residual_explain(p_user uuid, p_month date)
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
  v_ca int; v_ca_types jsonb;
  v_cols text[] := ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                         'free_replacement_refund_items','compensated_clawback',
                         'reimbursements','fbm_shipping_label_fee'];
BEGIN
  v_body := public.repull_find_report(v_start, false, NULL, true);

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

  -- THE REAL GATE: what the router itself counted, not what the column mix
  -- happens to look like.
  v_ca       := (v_body->>'api_items_via_catchall')::int;
  v_ca_types := COALESCE(v_body->'api_catchall_types','[]'::jsonb);

  IF v_ca IS NULL THEN
    RAISE NOTICE '   !! this report predates api_items_via_catchall -- gate unknown, re-run the month';
  ELSIF v_ca > 0 THEN
    RAISE NOTICE '   >>> UNMAPPED ADJUSTMENT TYPE: % item(s) hit the catch-all branch', v_ca;
    RAISE NOTICE '       types: %', v_ca_types;
    RAISE NOTICE '       STOP -- needs a routing decision, not a backfill.';
  ELSE
    RAISE NOTICE '   GATE CLEAR: api_items_via_catchall = 0, types % -- no unmapped AdjustmentType',
      v_ca_types;
    IF jsonb_array_length(COALESCE(v_ms->'reimbursements','[]'::jsonb)) > 0 THEN
      RAISE NOTICE '   (the reimbursements multiset is non-empty: % amount(s). That is negative',
        jsonb_array_length(v_ms->'reimbursements');
      RAISE NOTICE '    LOST/DAMAGE routed there by design, NOT a catch-all. Amounts: %',
        v_ms->'reimbursements';
    END IF;
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
          WHERE user_id = %L AND event_type = 'adjustment'
            AND event_date >= %L AND event_date < %L
            AND COALESCE(%I,0) <> 0
          GROUP BY 1
        )
        SELECT COALESCE(api.amt, cur.amt) AS amt,
               COALESCE(cur.n,0) AS stored_n, COALESCE(api.n,0) AS api_n
        FROM api FULL OUTER JOIN cur ON cur.amt = api.amt
        WHERE COALESCE(api.n,0) <> COALESCE(cur.n,0)
        ORDER BY 1
      $q$, v_ms->v_col, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      % | stored % -> api % | %',
        lpad(r.amt::text,16), lpad(r.stored_n::text,3), lpad(r.api_n::text,3),
        CASE WHEN r.api_n > r.stored_n THEN 'appeared' ELSE 'vanished' END;
    END LOOP;

    FOR r IN
      EXECUTE format($q$
        WITH api AS (
          SELECT round(x::numeric,2) AS amt, count(*) AS n
          FROM jsonb_array_elements_text(%L::jsonb) AS t(x) GROUP BY 1
        ), cur AS (
          SELECT round(%I,2) AS amt, count(*) AS n
          FROM public.financial_events_cache
          WHERE user_id = %L AND event_type = 'adjustment'
            AND event_date >= %L AND event_date < %L
            AND COALESCE(%I,0) <> 0
          GROUP BY 1
        ), gone AS (
          SELECT cur.amt FROM cur LEFT JOIN api ON api.amt = cur.amt
          WHERE COALESCE(api.n,0) < cur.n
        ), arrived AS (
          SELECT api.amt FROM api LEFT JOIN cur ON cur.amt = api.amt
          WHERE COALESCE(cur.n,0) < api.n
        )
        SELECT g.amt AS whole, a1.amt AS p1, a2.amt AS p2
        FROM gone g
        JOIN arrived a1 ON a1.amt < g.amt
        JOIN arrived a2 ON a2.amt < g.amt AND a2.amt > a1.amt
        WHERE round(a1.amt + a2.amt, 2) = round(g.amt, 2)
      $q$, v_ms->v_col, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      PAIRED % = % + %  (collision unpack, money-neutral)',
        r.whole, r.p2, r.p1;
    END LOOP;
  END LOOP;
END
$fn$;

-- ---- now read AUGUST, and fire SEPTEMBER only if August landed ----
DO $p$
DECLARE
  r record; v_uid uuid; v_api numeric; v_st numeric; v_claw numeric; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '-- MAY re-read with the corrected gate --';
  PERFORM public.repull_residual_explain(v_uid,'2026-05-01');

  SELECT (report->>'api_signed_total')::numeric,
         (report->>'stored_signed_total')::numeric,
         (report->>'api_clawback_total')::numeric
    INTO v_api, v_st, v_claw
  FROM public.repull_reports WHERE left(month,7)='2026-08'
  ORDER BY captured_at DESC LIMIT 1;

  RAISE NOTICE '';
  IF v_api IS NULL THEN
    RAISE NOTICE 'AUGUST has not landed yet. NOT firing September.';
    RETURN;
  END IF;

  RAISE NOTICE '############ AUGUST ############';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI:SS') AS t,
           report->>'api_items' AS items, report->>'api_rows_after_dedupe' AS dedup,
           report->>'stored_rows' AS stored, report->>'pages' AS pages,
           report->>'rate_limit_hits' AS rl, report->>'api_items_via_catchall' AS ca,
           COALESCE(report->>'api_catchall_types','-') AS ctypes,
           report->>'api_items_routed_to_nothing' AS nulls,
           report->>'api_items_skipped_liquidation' AS liq,
           report->>'elapsed_ms' AS ms, report->>'wrote' AS wrote
    FROM public.repull_reports WHERE left(month,7)='2026-08'
    ORDER BY captured_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '   captured % | % ms | wrote %', r.t, r.ms, r.wrote;
    RAISE NOTICE '   % api items -> % after dedupe | % stored rows | % pages | % rate-limit hits',
      r.items, r.dedup, r.stored, r.pages, r.rl;
    RAISE NOTICE '   routed to nothing % | skipped liquidation %', r.nulls, r.liq;
    RAISE NOTICE '   VIA CATCH-ALL: %   types: %', r.ca, r.ctypes;
  END LOOP;
  RAISE NOTICE '   stored % -> api %', v_st, v_api;
  RAISE NOTICE '   net change %  =  clawbacks %  +  residual %',
    round(v_api-v_st,2), v_claw, round((v_api-v_st)-v_claw,2);

  PERFORM public.repull_residual_explain(v_uid,'2026-08-01');

  RAISE NOTICE '';
  IF EXISTS (SELECT 1 FROM net.http_request_queue q
             WHERE q.url LIKE '%repull-month-adjustments%') THEN
    RAISE NOTICE 'a repull is still queued in pg_net -- NOT firing September';
    RETURN;
  END IF;

  v_req := public.repull_fire(v_uid, '2026-09-01'::date, false);
  RAISE NOTICE 'fired SEPTEMBER dry run, pg_net request %', v_req;
END
$p$;
