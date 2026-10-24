-- Read MAY (request 56622), then fire AUGUST only if May has actually landed.
-- The conditional is the "wait for each report to persist" rule expressed in
-- SQL: if May has no report, August is not fired and nothing is lost.
-- apply := false throughout. Nothing is written to financial_events_cache.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_api numeric; v_st numeric; v_claw numeric; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT (report->>'api_signed_total')::numeric,
         (report->>'stored_signed_total')::numeric,
         (report->>'api_clawback_total')::numeric
    INTO v_api, v_st, v_claw
  FROM public.repull_reports WHERE left(month,7)='2026-05'
  ORDER BY captured_at DESC LIMIT 1;

  IF v_api IS NULL THEN
    RAISE NOTICE 'MAY has still not landed. NOT firing August.';
    RETURN;
  END IF;

  RAISE NOTICE '############ MAY ############';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI:SS') AS t,
           report->>'api_items' AS items, report->>'api_rows_after_dedupe' AS dedup,
           report->>'stored_rows' AS stored,
           report->>'pages' AS pages, report->>'rate_limit_hits' AS rl,
           report->>'api_items_via_catchall' AS ca,
           COALESCE(report->>'api_catchall_types','-') AS ctypes,
           report->>'api_items_routed_to_nothing' AS nulls,
           report->>'api_items_skipped_liquidation' AS liq,
           report->>'elapsed_ms' AS ms, report->>'wrote' AS wrote
    FROM public.repull_reports WHERE left(month,7)='2026-05'
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

  RAISE NOTICE '';
  RAISE NOTICE '-- MAY multiset pairings --';
  BEGIN
    PERFORM public.repull_residual_explain(v_uid,'2026-05-01');
  EXCEPTION WHEN others THEN RAISE NOTICE '   explain failed: %', SQLERRM;
  END;

  -- ---- now August, and only now ----
  RAISE NOTICE '';
  IF EXISTS (SELECT 1 FROM net.http_request_queue q
             WHERE q.url LIKE '%repull-month-adjustments%') THEN
    RAISE NOTICE 'a repull is still in the pg_net queue -- NOT firing August';
    RETURN;
  END IF;

  v_req := public.repull_fire(v_uid, '2026-08-01'::date, false);
  RAISE NOTICE 'fired AUGUST dry run, pg_net request %', v_req;
END
$p$;
