-- Fix the pairing detector so equal halves can pair, and make it say what is
-- left over once the pairs are removed.
--
-- TWO BUGS, both found on February
-- --------------------------------
-- 1. EQUAL HALVES COULD NEVER PAIR. The join read:
--
--        JOIN arrived a2 ON a2.amt < g.amt AND a2.amt > a1.amt
--
--    The strict a2.amt > a1.amt was there to print each unordered pair once,
--    but it also made an exact double impossible. February unpacks 2 x 28.94
--    into 4 x 14.47, so it printed NO pairings at all while being almost
--    entirely money-neutral -- the worst possible failure for a detector whose
--    whole job is to say "this movement did not change the total".
--
--    Now the join is a2.amt <= a1.amt, which still yields each unordered pair
--    once (a1 is the larger-or-equal half), plus a guard: equal halves are
--    only allowed when that amount actually has surplus multiplicity >= 2,
--    because one arrived row cannot be used twice.
--
-- 2. gone AND arrived THREW AWAY MULTIPLICITY. They selected only the amount,
--    so the guard above had nothing to test and a 5x surplus looked like a 1x
--    surplus. Both now carry the surplus count.
--
-- ALSO ADDED: the leftover report. Pairings alone do not explain a residual --
-- what explains it is what is still unmatched after the pairings are removed.
-- On February that is 28.69 -> 28.93 and 29.89 -> 29.79, which is the entire
-- +0.14. Note the "used" test treats an amount as used if it appears as
-- EITHER half, since addition commutes; an earlier hand-written version of
-- this check only tested the larger position and wrongly reported 7.42 as
-- unexplained when it is the smaller half of 16.03.
--
-- Still two-term only. A vanished amount that split three ways will show as
-- unexplained rather than wrongly paired, which is the safe direction.
--
-- DIAGNOSTIC ONLY. Reads reports and financial_events_cache, writes nothing.
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
  v_ca int; v_ca_types jsonb; v_found boolean;
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

  v_ms       := v_body->'api_amount_multiset';
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
      RAISE NOTICE '   (reimbursements multiset non-empty: % amount(s) -- negative LOST/DAMAGE',
        jsonb_array_length(v_ms->'reimbursements');
      RAISE NOTICE '    routed there by design, NOT a catch-all. Amounts: %', v_ms->'reimbursements';
    END IF;
  END IF;

  FOREACH v_col IN ARRAY ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                               'free_replacement_refund_items','compensated_clawback',
                               'reimbursements','fbm_shipping_label_fee'] LOOP
    CONTINUE WHEN jsonb_array_length(COALESCE(v_ms->v_col,'[]'::jsonb)) = 0;
    RAISE NOTICE '   -- % --', v_col;

    -- surplus on each side, WITH multiplicity
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
        lpad(r.amt::text,12), lpad(r.stored_n::text,3), lpad(r.api_n::text,3),
        CASE WHEN r.api_n > r.stored_n THEN 'appeared' ELSE 'vanished' END;
    END LOOP;

    -- money-neutral unpacks, equal halves included
    v_found := false;
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
          SELECT cur.amt, cur.n - COALESCE(api.n,0) AS n
          FROM cur LEFT JOIN api ON api.amt = cur.amt
          WHERE cur.n - COALESCE(api.n,0) > 0
        ), arrived AS (
          SELECT api.amt, api.n - COALESCE(cur.n,0) AS n
          FROM api LEFT JOIN cur ON cur.amt = api.amt
          WHERE api.n - COALESCE(cur.n,0) > 0
        )
        SELECT DISTINCT g.amt AS whole, a1.amt AS big, a2.amt AS small, g.n AS times
        FROM gone g
        JOIN arrived a1 ON a1.amt < g.amt
        JOIN arrived a2 ON a2.amt <= a1.amt
        WHERE round(a1.amt + a2.amt, 2) = round(g.amt, 2)
          AND (a2.amt < a1.amt OR a1.n >= 2)
        ORDER BY 1
      $q$, v_ms->v_col, v_col, p_user, v_start, v_end, v_col)
    LOOP
      v_found := true;
      IF r.times > 1 THEN
        RAISE NOTICE '      NEUTRAL % = % + %   (x%, collision unpack)',
          r.whole, r.big, r.small, r.times;
      ELSE
        RAISE NOTICE '      NEUTRAL % = % + %   (collision unpack)', r.whole, r.big, r.small;
      END IF;
    END LOOP;

    -- what is actually restated: unmatched after the pairs are removed
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
          SELECT cur.amt, cur.n - COALESCE(api.n,0) AS n
          FROM cur LEFT JOIN api ON api.amt = cur.amt
          WHERE cur.n - COALESCE(api.n,0) > 0
        ), arrived AS (
          SELECT api.amt, api.n - COALESCE(cur.n,0) AS n
          FROM api LEFT JOIN cur ON cur.amt = api.amt
          WHERE api.n - COALESCE(cur.n,0) > 0
        )
        SELECT 'vanished' AS side, g.amt, g.n FROM gone g
        WHERE NOT EXISTS (
          SELECT 1 FROM arrived a1 JOIN arrived a2 ON a2.amt <= a1.amt
          WHERE a1.amt < g.amt AND round(a1.amt + a2.amt,2) = round(g.amt,2)
            AND (a2.amt < a1.amt OR a1.n >= 2))
        UNION ALL
        -- an arrived amount counts as used if it is EITHER half of some pair,
        -- because addition commutes
        SELECT 'appeared' AS side, a.amt, a.n FROM arrived a
        WHERE NOT EXISTS (
          SELECT 1 FROM gone g JOIN arrived b
            ON round(a.amt + b.amt,2) = round(g.amt,2)
          WHERE (b.amt <> a.amt OR a.n >= 2))
        ORDER BY 1, 2
      $q$, v_ms->v_col, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      RESTATED (unpaired) % % x%', rpad(r.side,9), r.amt, r.n;
    END LOOP;
  END LOOP;
END
$fn$;

-- ---- prove it on the months already measured ----
DO $p$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '';
  RAISE NOTICE '#### FEBRUARY -- the equal-halves case that printed nothing before ####';
  PERFORM public.repull_residual_explain(v_uid,'2026-02-01');
END
$p$;
