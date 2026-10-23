-- Automate the residual explanation. January's -$1.20 was resolved by eye:
-- pairing vanished amounts against the components they split into and spotting
-- the two Amazon had restated. Doing that by eye for seven more months is how
-- the $34.80 phantom gap happened, so SQL does the pairing from here.
--
-- It also answers the question that decides whether an apply may proceed at
-- all: is the residual an Amazon restatement, or an adjustment TYPE the router
-- does not map to a column? The second case is the dangerous one -- it means
-- money is landing in the catch-all (reimbursements) because the type is
-- unrecognised, and that needs a routing decision, not a backfill.

/**
 * Compare the API amount multiset (from a dry run's stored response) against
 * what is currently in the cache, per column.
 *
 * p_req is the pg_net request id of a DRY RUN whose report carries
 * api_amount_multiset.
 */
CREATE OR REPLACE FUNCTION public.repull_residual_explain(
  p_user uuid, p_month date, p_req bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_body jsonb; v_ms jsonb; r record; v_col text; v_unmapped int := 0;
  v_cols text[] := ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                         'free_replacement_refund_items','compensated_clawback',
                         'reimbursements','fbm_shipping_label_fee'];
BEGIN
  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = p_req;
  IF v_body IS NULL THEN RAISE NOTICE '   request % has no response', p_req; RETURN; END IF;
  v_ms := v_body->'api_amount_multiset';
  IF v_ms IS NULL THEN
    RAISE NOTICE '   request % predates api_amount_multiset -- re-run the dry run', p_req;
    RETURN;
  END IF;

  RAISE NOTICE '   == % residual analysis ==', to_char(v_start,'YYYY-MM');

  -- THE GATE. A non-empty reimbursements multiset means the catch-all fired,
  -- i.e. at least one AdjustmentType is not mapped to a column of its own.
  IF jsonb_array_length(COALESCE(v_ms->'reimbursements','[]'::jsonb)) > 0 THEN
    v_unmapped := jsonb_array_length(v_ms->'reimbursements');
    RAISE NOTICE '   >>> STOP: % API rows routed to the CATCH-ALL (reimbursements).', v_unmapped;
    RAISE NOTICE '       That means an AdjustmentType the router does not map to its';
    RAISE NOTICE '       own column. Amounts: %', v_ms->'reimbursements';
    RAISE NOTICE '       This needs a routing decision, not a backfill.';
  ELSE
    RAISE NOTICE '   catch-all (reimbursements) is EMPTY: every API row mapped to a';
    RAISE NOTICE '   named column, so no unmapped AdjustmentType is involved.';
  END IF;

  FOREACH v_col IN ARRAY v_cols LOOP
    CONTINUE WHEN jsonb_array_length(COALESCE(v_ms->v_col,'[]'::jsonb)) = 0
             AND NOT EXISTS (
               SELECT 1 FROM public.financial_events_cache f
               WHERE f.user_id=p_user AND f.event_type='adjustment'
                 AND f.event_date>=v_start AND f.event_date<v_end
                 AND COALESCE((to_jsonb(f)->>v_col)::numeric,0) <> 0);

    RAISE NOTICE '';
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
               COALESCE(cur.n,0) AS before_n, COALESCE(api.n,0) AS after_n
        FROM cur FULL OUTER JOIN api ON api.amt = cur.amt
        WHERE COALESCE(cur.n,0) <> COALESCE(api.n,0)
        ORDER BY 1
      $q$, COALESCE(v_ms->v_col,'[]'::jsonb)::text, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      amount % | stored % -> api % | change %',
        lpad(r.amt::text,10), lpad(r.before_n::text,3), lpad(r.after_n::text,3),
        r.after_n - r.before_n;
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '      multisets identical'; END IF;

    -- Attempt two-component pairings for amounts that vanished.
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
        ), appeared AS (
          SELECT api.amt FROM api LEFT JOIN cur ON cur.amt=api.amt
          WHERE COALESCE(cur.n,0) < api.n
        )
        SELECT g.amt AS vanished, a1.amt AS p1, a2.amt AS p2
        FROM gone g
        JOIN appeared a1 ON a1.amt < g.amt
        JOIN appeared a2 ON a2.amt <= a1.amt
        WHERE round(a1.amt + a2.amt, 2) = g.amt
        ORDER BY g.amt
      $q$, COALESCE(v_ms->v_col,'[]'::jsonb)::text, v_col, p_user, v_start, v_end, v_col)
    LOOP
      RAISE NOTICE '      PAIRED: % = % + %  (collision unpacking, money-neutral)',
        r.vanished, r.p1, r.p2;
    END LOOP;
  END LOOP;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_residual_explain(uuid, date, bigint) TO service_role;

DO $p$
DECLARE v_uid uuid; v_req bigint; v_ok boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== June (39338) ==';
  v_ok := public.repull_report(39338);
  IF v_ok THEN
    RAISE NOTICE '';
    RAISE NOTICE '== DRY RUN: July, alone ==';
    BEGIN v_req := public.repull_fire(v_uid,'2026-07-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  ELSE
    RAISE NOTICE '   June still in flight -- holding July';
  END IF;
END
$p$;
