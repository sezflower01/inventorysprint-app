-- READ-ONLY PROBE — the BEFORE measurement for the analyser load work.
--
-- Two costs are being attacked:
--   #1 every edge-function invocation mints a fresh LWA access token against
--      api.amazon.com; there is no cache anywhere, and a panel load does 5-7 of
--      them. Measured separately by the timing harness, since it needs the
--      LWA secret.
--   #2 mobile-scan-price-history waits up to 12 s for a free 'pricing_api'
--      slot before it calls Amazon. This probe measures how contended that
--      bucket actually is right now, by asking for slots exactly as the
--      function does and recording what the limiter says.
--
-- consume_api_token returns (allowed, wait_ms). Ten consecutive asks show
-- whether a panel request would sail through or queue.

DO $p$
DECLARE r record; i int; v_allowed boolean; v_wait numeric; v_refused int := 0; v_total numeric := 0; v_max numeric := 0;
BEGIN
  RAISE NOTICE '== pricing_api bucket, 10 consecutive asks ==';
  FOR i IN 1..10 LOOP
    SELECT allowed, wait_ms INTO v_allowed, v_wait
    FROM public.consume_api_token('pricing_api', 1) LIMIT 1;
    RAISE NOTICE '  ask % : allowed % | wait_ms %', i, v_allowed, COALESCE(v_wait, 0);
    IF NOT COALESCE(v_allowed, false) THEN
      v_refused := v_refused + 1;
      v_total := v_total + COALESCE(v_wait, 0);
      IF COALESCE(v_wait, 0) > v_max THEN v_max := COALESCE(v_wait, 0); END IF;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  refused % of 10 | total suggested wait % ms | worst single wait % ms',
    v_refused, v_total, v_max;

  RAISE NOTICE '';
  RAISE NOTICE '== who else is spending this bucket right now ==';
  FOR r IN SELECT operation, last_called_at, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state
           ORDER BY last_called_at DESC NULLS LAST LIMIT 5 LOOP
    RAISE NOTICE '  % | % ago', r.operation, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== repricer load, which is what the panel competes with ==';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE last_applied_at > now() - interval '10 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % prices applied', r.m, r.n;
  END LOOP;
END
$p$;
