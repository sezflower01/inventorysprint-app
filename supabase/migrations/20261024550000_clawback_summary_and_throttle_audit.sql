-- Two refinements the regression run exposed, plus a throttle audit.
--
-- 1. compensated_clawback made the leftover report unreadable. Every clawback
--    is new by definition -- 0 stored across every month -- so listing each as
--    "RESTATED (unpaired) appeared" is noise, not a finding. March printed 15
--    such lines and April 18, burying the one line that matters. That column
--    now gets a one-line summary and the leftover detail is reserved for the
--    reimbursement columns, where an unpaired amount IS the finding.
--
-- 2. The regression run revealed that February is not the only throttled
--    month: March recorded 14 rate-limit hits and April 11. The audit at the
--    bottom prints the figure for all eight so the refresh list is decided by
--    measurement.
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
  v_ca int; v_ca_types jsonb; v_n int; v_sum numeric;
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
  RAISE NOTICE '   rate-limit hits % | pages % | items %',
    v_body->>'rate_limit_hits', v_body->>'pages', v_body->>'api_items';
  IF COALESCE((v_body->>'rate_limit_hits')::int,0) > 0 THEN
    RAISE NOTICE '   !! THROTTLED RUN -- refresh with a clean dry run before applying';
  END IF;

  v_ms       := v_body->'api_amount_multiset';
  v_ca       := (v_body->>'api_items_via_catchall')::int;
  v_ca_types := COALESCE(v_body->'api_catchall_types','[]'::jsonb);

  IF v_ca IS NULL THEN
    RAISE NOTICE '   !! predates api_items_via_catchall -- gate unknown, re-run the month';
  ELSIF v_ca > 0 THEN
    RAISE NOTICE '   >>> UNMAPPED ADJUSTMENT TYPE: % item(s) hit the catch-all branch', v_ca;
    RAISE NOTICE '       types: %', v_ca_types;
    RAISE NOTICE '       STOP -- needs a routing decision, not a backfill.';
  ELSE
    RAISE NOTICE '   GATE CLEAR: api_items_via_catchall = 0, types %', v_ca_types;
    IF jsonb_array_length(COALESCE(v_ms->'reimbursements','[]'::jsonb)) > 0 THEN
      RAISE NOTICE '   (reimbursements multiset non-empty: % amount(s) -- negative LOST/DAMAGE',
        jsonb_array_length(v_ms->'reimbursements');
      RAISE NOTICE '    routed there by design, NOT a catch-all. Amounts: %', v_ms->'reimbursements';
    END IF;
  END IF;

  FOREACH v_col IN ARRAY ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                               'free_replacement_refund_items','reimbursements',
                               'fbm_shipping_label_fee','compensated_clawback'] LOOP
    CONTINUE WHEN jsonb_array_length(COALESCE(v_ms->v_col,'[]'::jsonb)) = 0;

    -- Clawbacks are new by construction. One line, not forty.
    IF v_col = 'compensated_clawback' THEN
      EXECUTE format($q$
        SELECT count(*), COALESCE(sum(x::numeric),0)
        FROM jsonb_array_elements_text(%L::jsonb) AS t(x)
      $q$, v_ms->v_col) INTO v_n, v_sum;
      EXECUTE format($q$
        SELECT count(*) FROM public.financial_events_cache
        WHERE user_id = %L AND event_type='adjustment'
          AND event_date >= %L AND event_date < %L
          AND COALESCE(compensated_clawback,0) <> 0
      $q$, p_user, v_start, v_end) INTO v_ca;
      RAISE NOTICE '   -- compensated_clawback -- % rows totalling %, currently % stored',
        v_n, round(v_sum,2), v_ca;
      CONTINUE;
    END IF;

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
            AND event_date >= %L AND event_date < %L AND COALESCE(%I,0) <> 0
          GROUP BY 1
        ), gone AS (
          SELECT cur.amt, cur.n - COALESCE(api.n,0) AS n
          FROM cur LEFT JOIN api ON api.amt = cur.amt
          WHERE cur.n - COALESCE(api.n,0) > 0
        ), arrived AS (
          SELECT api.amt, api.n - COALESCE(cur.n,0) AS n
          FROM api LEFT JOIN cur ON cur.amt = api.amt
          WHERE api.n - COALESCE(cur.n,0) > 0
        ), pairs AS (
          SELECT DISTINCT g.amt AS whole, a1.amt AS big, a2.amt AS small, g.n AS times
          FROM gone g
          JOIN arrived a1 ON a1.amt < g.amt
          JOIN arrived a2 ON a2.amt <= a1.amt
          WHERE round(a1.amt + a2.amt, 2) = round(g.amt, 2)
            AND (a2.amt < a1.amt OR a1.n >= 2)
        )
        SELECT 1 AS ord, 'NEUTRAL  '||whole||' = '||big||' + '||small||
               CASE WHEN times > 1 THEN '   (x'||times||', collision unpack)'
                    ELSE '   (collision unpack)' END AS line
        FROM pairs
        UNION ALL
        SELECT 2, 'RESTATED vanished '||g.amt||' x'||g.n
        FROM gone g WHERE NOT EXISTS (SELECT 1 FROM pairs p WHERE p.whole = g.amt)
        UNION ALL
        SELECT 2, 'RESTATED appeared '||a.amt||' x'||a.n
        FROM arrived a WHERE NOT EXISTS (
          SELECT 1 FROM pairs p WHERE p.big = a.amt OR p.small = a.amt)
        UNION ALL
        SELECT 3, 'net for this column: '||
               round(COALESCE((SELECT sum(amt*n) FROM arrived),0)
                   - COALESCE((SELECT sum(amt*n) FROM gone),0), 2)
        ORDER BY 1, 2
      $q$, v_ms->v_col, v_col, p_user, v_start, v_end, v_col)
    LOOP RAISE NOTICE '      %', r.line; END LOOP;
  END LOOP;
END
$fn$;

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '################ THROTTLE AUDIT: all eight pending months ################';
  RAISE NOTICE '   a throttled run may have paged incompletely, so it is not a basis for a replace';
  FOR r IN
    SELECT left(month,7) AS m,
           (report->>'rate_limit_hits')::int AS rl,
           (report->>'pages')::int AS pages,
           (report->>'api_items')::int AS items,
           (report->>'api_clawback_total')::numeric AS claw,
           to_char(captured_at,'MM-DD HH24:MI') AS ran
    FROM public.repull_reports r1
    WHERE report ? 'rate_limit_hits' AND applied = false
      AND captured_at = (SELECT max(captured_at) FROM public.repull_reports r2
                         WHERE left(r2.month,7) = left(r1.month,7)
                           AND r2.report ? 'rate_limit_hits' AND r2.applied = false)
    ORDER BY 1
  LOOP
    RAISE NOTICE '   % | rate-limit hits % | % pages | % items | clawbacks % | ran % | %',
      r.m, lpad(r.rl::text,3), lpad(r.pages::text,3), lpad(r.items::text,4),
      lpad(r.claw::text,9), r.ran,
      CASE WHEN r.rl > 0 THEN 'REFRESH BEFORE APPLYING' ELSE 'clean' END;
  END LOOP;
END
$p$;
