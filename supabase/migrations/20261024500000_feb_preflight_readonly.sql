-- PRE-FLIGHT for stage 2, and February's complete pre-apply picture.
-- READ-ONLY. Nothing is written, not even the backup -- see the note below.
--
-- WHY NO BACKUP YET
-- -----------------
-- fec_backup_month deliberately REFUSES to overwrite an existing backup
-- ("keeping the ORIGINAL"). Taking February's backup today, two days before
-- the approved Sunday 15:00 UTC slot, would therefore create a snapshot that
-- cannot be refreshed if anything touches February in between -- and a stale
-- rollback source is worse than none, because it looks valid. The backup
-- belongs in the same sequence as the apply, so it is taken then.
--
-- The pre-apply check that proves the backup is still good is the diff itself:
-- immediately after fec_backup_month and BEFORE the replace, fec_diff_month
-- must return zero rows. If it does not, backup and live have diverged and the
-- month stops.
DO $p$
DECLARE
  r record; v_uid uuid; v_body jsonb; v_col text;
  v_api numeric; v_stored numeric; v_claw numeric; v_resid numeric;
  v_sum_api numeric; v_sum_stored numeric; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '################ PRE-FLIGHT 1: cron failure clusters, last 24h ################';
  FOR r IN
    SELECT to_char(d.start_time,'MM-DD HH24:MI') AS minute, count(*) AS failed,
           round(max(EXTRACT(EPOCH FROM (d.end_time-d.start_time)))::numeric,1) AS held_s,
           string_agg(DISTINCT left(COALESCE(d.return_message,'-'),44), ' / ') AS msgs
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 HAVING count(*) >= 3
    ORDER BY 1
  LOOP
    RAISE NOTICE '   CLUSTER % | % jobs failed | held up to % s', r.minute, r.failed, r.held_s;
    RAISE NOTICE '      %', r.msgs;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   CLEAR -- no minute in 24h had 3 or more jobs fail together'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   all failures in 24h, by job:';
  FOR r IN
    SELECT j.jobname, count(*) AS failed,
           left(COALESCE(max(d.return_message),'-'),60) AS msg
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.start_time >= now() - interval '24 hours' AND d.status <> 'succeeded'
    GROUP BY 1 ORDER BY failed DESC LIMIT 10
  LOOP RAISE NOTICE '      % | % failed | %', rpad(r.jobname,38), lpad(r.failed::text,4), r.msg; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      none at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '################ PRE-FLIGHT 2: pg_net backlog ################';
  SELECT count(*) INTO v_n FROM net.http_request_queue;
  RAISE NOTICE '   request queue depth: % (any non-zero means calls are still unsent)', v_n;
  FOR r IN
    SELECT count(*) AS n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%'
  LOOP RAISE NOTICE '   of which repull calls: %', r.n; END LOOP;
  FOR r IN
    SELECT count(*) AS n, min(created) AS oldest, max(created) AS newest FROM net._http_response
  LOOP RAISE NOTICE '   responses retained: % | % .. %', r.n, r.oldest, r.newest; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   load in the last hour, for comparison with the 12:33 stall:';
  FOR r IN
    SELECT max(active_connections) AS mc, max(waiting_queries) AS mw,
           round(max(avg_query_ms_5m)::numeric,0) AS mms, count(*) AS samples
    FROM public.system_load_snapshot WHERE captured_at >= now() - interval '1 hour'
  LOOP RAISE NOTICE '      % samples | conns max % | waiting max % | ms max %', r.samples, r.mc, r.mw, r.mms; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '################ FEBRUARY: pre-apply state ################';

  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-02-01' AND event_date < '2026-03-01';
  RAISE NOTICE '   live rows in February, ALL event types: %', v_n;

  FOR r IN
    SELECT event_type, count(*) AS n
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-02-01' AND event_date < '2026-03-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % rows', rpad(r.event_type,16), lpad(r.n::text,5); END LOOP;

  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month = '2026-02-01';
  RAISE NOTICE '   existing February backup rows: % (0 means the backup is still to be taken)', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   the four non-adjustment fingerprints, BEFORE (must be identical after):';
  v_n := 0;
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-02-01') ORDER BY event_type
  LOOP
    RAISE NOTICE '      % | % rows | %', rpad(r.event_type,16), lpad(r.rows::text,5), r.fingerprint;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '      -> % non-adjustment event types present', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   how many columns does a row have? ("40-column change")';
  FOR r IN
    SELECT count(*) AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache'
  LOOP RAISE NOTICE '      financial_events_cache has % columns', r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   diff vs backup RIGHT NOW (expect 0 rows -- no backup exists yet):';
  SELECT count(*) INTO v_n FROM public.fec_diff_month(v_uid,'2026-02-01');
  RAISE NOTICE '      % diff rows', v_n;

  -- ---- February's residual, decomposed ----
  v_body := public.repull_find_report('2026-02-01'::date, false, NULL, true);
  v_api    := (v_body->>'api_signed_total')::numeric;
  v_stored := (v_body->>'stored_signed_total')::numeric;
  v_claw   := (v_body->>'api_clawback_total')::numeric;
  v_resid  := round((v_api - v_stored) - v_claw, 2);

  RAISE NOTICE '';
  RAISE NOTICE '   dry run on file: % items | % pages | % rate-limit hits | catch-all % | types %',
    v_body->>'api_items', v_body->>'pages', v_body->>'rate_limit_hits',
    v_body->>'api_items_via_catchall', v_body->'api_catchall_types';
  RAISE NOTICE '   stored % -> api % | net % | clawbacks % | RESIDUAL %',
    v_stored, v_api, round(v_api-v_stored,2), v_claw, v_resid;

  RAISE NOTICE '';
  RAISE NOTICE '   per-column net change:';
  FOREACH v_col IN ARRAY ARRAY['reversal_reimbursement','warehouse_lost','warehouse_damage',
                               'free_replacement_refund_items','compensated_clawback',
                               'reimbursements','fbm_shipping_label_fee'] LOOP
    EXECUTE format($q$
      SELECT
        (SELECT COALESCE(sum(x::numeric),0)
           FROM jsonb_array_elements_text(COALESCE(%L::jsonb,'[]'::jsonb)) AS t(x)),
        (SELECT COALESCE(sum(%I),0) FROM public.financial_events_cache
          WHERE user_id = %L AND event_type='adjustment'
            AND event_date >= '2026-02-01' AND event_date < '2026-03-01')
    $q$, v_body->'api_amount_multiset'->v_col, v_col, v_uid)
    INTO v_sum_api, v_sum_stored;
    IF round(v_sum_api,2) = 0 AND round(v_sum_stored,2) = 0 THEN CONTINUE; END IF;
    RAISE NOTICE '      % | stored % -> api % | delta %',
      rpad(v_col,32), lpad(round(v_sum_stored,2)::text,10),
      lpad(round(v_sum_api,2)::text,10), lpad(round(v_sum_api-v_sum_stored,2)::text,9);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   UNPAIRED amounts behind the % residual:', v_resid;
  PERFORM public.repull_residual_explain(v_uid,'2026-02-01');
END
$p$;
