-- Attribute each month's residual to a COLUMN, which the amount-by-amount dump
-- cannot do at a glance, and read SEPTEMBER. READ-ONLY.
--
-- The per-column delta is the honest way to read a residual: a column whose
-- net is 0.00 moved money around (collision unpacking) without changing the
-- total, and a column with a non-zero net is where the residual actually is.
DO $p$
DECLARE
  m record; r record; v_body jsonb; v_col text;
  v_api numeric; v_stored numeric; v_claw numeric; v_resid numeric;
  v_uid uuid; v_sum_api numeric; v_sum_stored numeric; v_resid_check numeric;
  v_cols text[] := ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                         'free_replacement_refund_items','compensated_clawback',
                         'reimbursements','fbm_shipping_label_fee'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  FOR m IN
    SELECT unnest(ARRAY['2026-05-01','2026-08-01','2026-09-01']::date[]) AS mon
  LOOP
    v_body := public.repull_find_report(m.mon, false, NULL, true);
    RAISE NOTICE '';
    RAISE NOTICE '################ % ################', to_char(m.mon,'YYYY-MM');
    IF v_body IS NULL THEN
      RAISE NOTICE '   no report with a multiset yet';
      CONTINUE;
    END IF;

    v_api    := (v_body->>'api_signed_total')::numeric;
    v_stored := (v_body->>'stored_signed_total')::numeric;
    v_claw   := (v_body->>'api_clawback_total')::numeric;
    v_resid  := round((v_api - v_stored) - v_claw, 2);

    RAISE NOTICE '   items % | pages % | rate-limit hits % | catch-all % | types %',
      v_body->>'api_items', v_body->>'pages', v_body->>'rate_limit_hits',
      v_body->>'api_items_via_catchall', v_body->'api_catchall_types';
    RAISE NOTICE '   stored % -> api % | net % | clawbacks % | RESIDUAL %',
      v_stored, v_api, round(v_api-v_stored,2), v_claw, v_resid;
    RAISE NOTICE '';
    RAISE NOTICE '   per-column net change:';
    v_resid_check := 0;

    FOREACH v_col IN ARRAY v_cols LOOP
      EXECUTE format($q$
        SELECT
          (SELECT COALESCE(sum(x::numeric),0)
             FROM jsonb_array_elements_text(COALESCE(%L::jsonb,'[]'::jsonb)) AS t(x)),
          (SELECT COALESCE(sum(%I),0) FROM public.financial_events_cache
            WHERE user_id = %L AND event_type='adjustment'
              AND event_date >= %L AND event_date < %L)
      $q$, v_body->'api_amount_multiset'->v_col, v_col, v_uid, m.mon,
           (date_trunc('month',m.mon)+interval '1 month')::date)
      INTO v_sum_api, v_sum_stored;

      IF round(v_sum_api,2) = 0 AND round(v_sum_stored,2) = 0 THEN CONTINUE; END IF;

      RAISE NOTICE '      % | stored % -> api % | delta %',
        rpad(v_col,32), lpad(round(v_sum_stored,2)::text,10),
        lpad(round(v_sum_api,2)::text,10),
        lpad(round(v_sum_api - v_sum_stored,2)::text,9);

      IF v_col <> 'compensated_clawback' THEN
        v_resid_check := v_resid_check + round(v_sum_api - v_sum_stored, 2);
      END IF;
    END LOOP;

    RAISE NOTICE '      %', repeat('-',70);
    RAISE NOTICE '      non-clawback columns sum to % (the residual, independently)',
      round(v_resid_check,2);
    IF round(v_resid_check,2) = v_resid THEN
      RAISE NOTICE '      AGREES with % from the report header', v_resid;
    ELSE
      RAISE NOTICE '      !! DISAGREES with % from the header -- investigate', v_resid;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== was September actually fired? ==';
  FOR r IN
    SELECT count(*) AS n FROM public.repull_reports WHERE left(month,7)='2026-09'
  LOOP RAISE NOTICE '   September reports on file: %', r.n; END LOOP;
  FOR r IN SELECT count(*) AS q FROM net.http_request_queue
           WHERE url LIKE '%repull-month-adjustments%'
  LOOP RAISE NOTICE '   repull calls still queued in pg_net: %', r.q; END LOOP;
END
$p$;
