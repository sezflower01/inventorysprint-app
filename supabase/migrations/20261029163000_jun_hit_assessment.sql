-- JUNE stopped on GATE 1: rate_limit_hits = 1. Nothing was backed up or
-- applied. This migration is READ-ONLY and decides nothing -- it assembles the
-- evidence for whether that single hit cost us any data.
--
-- The question that matters is NOT "was there a hit" but "did the hit truncate
-- the fetch". A hit that was retried and absorbed leaves the totals intact; one
-- that dropped a page does not. So: compare this run field-by-field against the
-- clean 10-24 run that reported 0 hits, and against all seven stored reports.
--
-- Note how February went wrong in the other direction: I stopped a clean run on
-- a rate-limit count read off a stale report, then built a whole "structurally
-- throttled" theory on it. So the comparison is printed in full rather than
-- summarised to a verdict.
DO $p$
DECLARE r record; v_fresh jsonb; v_clean jsonb; v_k text;
BEGIN
  v_fresh := public.repull_find_fresh_report('2026-06-01'::date, '2026-10-30 00:01:54.932049+00'::timestamptz);

  SELECT rr.report INTO v_clean
  FROM public.repull_reports rr
  WHERE left(rr.month,7) = '2026-06' AND rr.applied = false
    AND (rr.report->>'rate_limit_hits')::int = 0
    AND rr.captured_at < '2026-10-30 00:00:00+00'
  ORDER BY rr.captured_at DESC LIMIT 1;

  IF v_fresh IS NULL OR v_clean IS NULL THEN
    RAISE EXCEPTION 'need both the fresh run and a clean comparator';
  END IF;

  RAISE NOTICE '== every scalar field: FRESH (1 hit) vs CLEAN 10-24 (0 hits) ==';
  FOR v_k IN
    SELECT k FROM (
      SELECT jsonb_object_keys(v_fresh) AS k
      UNION SELECT jsonb_object_keys(v_clean)
    ) s ORDER BY k
  LOOP
    IF jsonb_typeof(COALESCE(v_fresh->v_k, v_clean->v_k)) IN ('object','array') THEN
      CONTINUE;
    END IF;
    RAISE NOTICE '   %  fresh % | clean % | %',
      rpad(v_k,26),
      lpad(COALESCE(v_fresh->>v_k,'-'),14),
      lpad(COALESCE(v_clean->>v_k,'-'),14),
      CASE WHEN COALESCE(v_fresh->>v_k,'~') = COALESCE(v_clean->>v_k,'~')
           THEN 'same' ELSE '<-- DIFFERS' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== all stored June reports: did the totals ever move? ==';
  FOR r IN
    SELECT to_char(rr.captured_at,'MM-DD HH24:MI:SS') AS t,
           rr.report->>'rate_limit_hits' AS hits,
           rr.report->>'api_items'       AS items,
           rr.report->>'pages'           AS pages,
           rr.report->>'api_clawback_total' AS claw,
           rr.report->>'api_signed_total'   AS signed
    FROM public.repull_reports rr
    WHERE left(rr.month,7) = '2026-06'
    ORDER BY rr.captured_at
  LOOP
    RAISE NOTICE '   % | hits % | items % | pages % | claw % | signed %',
      r.t, lpad(COALESCE(r.hits,'-'),3), lpad(COALESCE(r.items,'-'),4),
      lpad(COALESCE(r.pages,'-'),4), lpad(COALESCE(r.claw,'-'),9),
      lpad(COALESCE(r.signed,'-'),9);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== state check: nothing was written ==';
  RAISE NOTICE '   June backup rows: % (must be 0)',
    (SELECT count(*) FROM public.fec_repull_backup WHERE backup_month='2026-06-01');
  RAISE NOTICE '   repull calls queued: % (must be 0)',
    (SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%');
END
$p$;
