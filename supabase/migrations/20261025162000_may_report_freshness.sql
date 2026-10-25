-- READ-ONLY. Is the May report I just gated on actually the fresh one?
DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== every May report, newest last ==';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI:SS') AS t, applied,
           COALESCE(report->>'api_items','-') AS items,
           COALESCE(report->>'pages','-') AS pages,
           COALESCE(report->>'elapsed_ms','-') AS ms,
           COALESCE(report->>'rate_limit_hits','-') AS rl,
           COALESCE(report->>'api_clawback_total','-') AS claw
    FROM public.repull_reports WHERE left(month,7)='2026-05'
    ORDER BY captured_at
  LOOP
    RAISE NOTICE '   % | applied % | % items | % pages | % ms | % hits | claw %',
      r.t, r.applied, r.items, r.pages, r.ms, r.rl, r.claw;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.repull_reports WHERE left(month,7)='2026-05';
  RAISE NOTICE '   total May reports: %', v_n;

  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%';
  RAISE NOTICE '   repull calls still queued: %', v_n;
END
$p$;
