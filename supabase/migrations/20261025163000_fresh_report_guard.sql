-- A freshness guard for the stage-2 gate, plus the diagnosis of request 73936.
--
-- repull_find_report returns the newest UNAPPLIED report for a month. It has no
-- idea which run asked. When a fresh run fails to land, it hands back the
-- previous one and every stop condition passes against stale evidence -- which
-- is exactly what happened on May: the fire returned request 73936, no report
-- persisted, and the gate green-lit yesterday's 15:14 report.
--
-- The guard takes the moment the run was fired and refuses anything not newer.
CREATE OR REPLACE FUNCTION public.repull_find_fresh_report(
  p_month date, p_fired_at timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT r.report
  FROM public.repull_reports r
  WHERE left(r.month,7) = to_char(p_month,'YYYY-MM')
    AND r.applied = false
    AND r.report ? 'api_signed_total'
    AND r.captured_at > p_fired_at
  ORDER BY r.captured_at DESC
  LIMIT 1;
$fn$;

COMMENT ON FUNCTION public.repull_find_fresh_report(date, timestamptz) IS
  'Stage-2 gate helper. Returns the newest unapplied report for the month that was captured AFTER p_fired_at, or NULL. NULL means "no fresh report" and must stop the run -- it must never be read as "nothing to check".';

DO $p$
DECLARE v_old jsonb; v_fresh jsonb; r record; v_n int;
BEGIN
  RAISE NOTICE '############ TEST: does the guard refuse a stale report? ############';

  -- The only May report is from 2026-10-24 15:14. Asking with a fired_at AFTER
  -- it must return NULL; asking with one BEFORE it must return the report.
  v_fresh := public.repull_find_fresh_report('2026-05-01'::date, now());
  v_old   := public.repull_find_fresh_report('2026-05-01'::date, '2026-10-01'::timestamptz);

  RAISE NOTICE '   fired_at = now()        -> % (want NULL)',
    CASE WHEN v_fresh IS NULL THEN 'NULL' ELSE 'A REPORT -- GUARD FAILED' END;
  RAISE NOTICE '   fired_at = 2026-10-01   -> % (want a report)',
    CASE WHEN v_old IS NULL THEN 'NULL -- GUARD TOO STRICT' ELSE 'report, clawbacks '||(v_old->>'api_clawback_total') END;

  IF v_fresh IS NOT NULL THEN RAISE EXCEPTION 'guard failed to refuse a stale report'; END IF;
  IF v_old IS NULL THEN RAISE EXCEPTION 'guard refused a legitimately older-but-requested report'; END IF;
  RAISE NOTICE '   GUARD WORKS';

  RAISE NOTICE '';
  RAISE NOTICE '############ WHY DID 73936 NOT PERSIST? ############';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE id = 73936;
  RAISE NOTICE '   still in the request queue: %', v_n;

  BEGIN
    FOR r IN
      SELECT id, status_code, left(COALESCE(error_msg,'-'),90) AS err,
             to_char(created,'HH24:MI:SS') AS t, left(COALESCE(content,''),160) AS body
      FROM net._http_response WHERE id IN (73897, 73936)
    LOOP
      RAISE NOTICE '   [%] % | status % | err %', r.id, r.t, COALESCE(r.status_code::text,'-'), r.err;
      IF r.body <> '' THEN RAISE NOTICE '        %', r.body; END IF;
    END LOOP;
    IF NOT FOUND THEN
      RAISE NOTICE '   neither 73897 (Feb) nor 73936 (May) has a response row.';
      RAISE NOTICE '   net._http_response is purged in batches, so absence is NOT';
      RAISE NOTICE '   proof the call failed -- but 73897 DID persist a report and';
      RAISE NOTICE '   73936 did not, so the difference is real.';
    END IF;
  EXCEPTION WHEN undefined_column THEN
    RAISE NOTICE '   net._http_response columns differ; skipping';
  END;

  RAISE NOTICE '';
  RAISE NOTICE '   response rows retained overall:';
  FOR r IN SELECT count(*) AS n, min(id) AS lo, max(id) AS hi FROM net._http_response
  LOOP RAISE NOTICE '      % rows | ids % .. %', r.n, r.lo, r.hi; END LOOP;
END
$p$;
