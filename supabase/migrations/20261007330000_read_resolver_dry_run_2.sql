DO $p$
DECLARE v jsonb; r record; n int := 0;
BEGIN
  SELECT content::jsonb INTO v FROM net._http_response WHERE id = 46646;
  IF v IS NULL THEN
    RAISE NOTICE '(request 46646 has not replied; checking the cron history run too)';
  ELSIF v ? 'error' THEN RAISE NOTICE 'ERROR: %', v->>'error';
  ELSE
    RAISE NOTICE 'apply=% ordersAsked=% rowsConsidered=%',
      v->>'apply', v->>'ordersAsked', v->>'rowsConsidered';
    RAISE NOTICE 'tally: %', v->'tally';
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v->'changes','[]'::jsonb)) AS e(c) LOOP
      n := n + 1;
      IF n <= 25 THEN
        RAISE NOTICE '  % | % | % -> % | sold % ',
          COALESCE(r.c->>'order_id','-'), COALESCE(r.c->>'asin','-'),
          rpad(COALESCE(r.c->'was'->>'status', r.c->>'action', '-'), 10),
          rpad(COALESCE(r.c->'now'->>'status', r.c->>'amazon_status', '-'), 10),
          COALESCE(r.c->'now'->>'sold_price','-');
      END IF;
    END LOOP;
    RAISE NOTICE '  (% changes total)', n;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== STEP 4: cron_run_history for the status sync ==';
  FOR r IN SELECT status, started_at, duration_ms, items_processed,
                  COALESCE(detail->>'ordersSeen','-') AS seen, COALESCE(left(error,60),'-') AS err
           FROM public.cron_run_history
           WHERE job_name = 'sync-order-status-updates-hourly'
           ORDER BY started_at DESC LIMIT 5 LOOP
    RAISE NOTICE '  % | % | %ms | % updated | % seen | %',
      r.started_at, rpad(r.status,9), r.duration_ms, r.items_processed, r.seen, r.err;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (still no rows)'; END IF;
END
$p$;
