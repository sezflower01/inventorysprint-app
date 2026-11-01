-- APPLY pass 2: report pass 1 from DURABLE state, then fire the next pass.
--
-- Yesterday's lesson applied: the counts below come from
-- collapsed_order_checks and sales_orders, not from the pg_net response, so
-- they survive the 6-hour prune. The response is read only for the throttle
-- figure, which is the one thing not recorded by design.
--
-- RULE 3 ENFORCEMENT IS IN HERE. If a pass spends most of its calls on
-- throttles, this stops and does NOT fire the next one. Grinding through 429s
-- is what the rule forbids, and resuming later costs nothing because a
-- throttled row is never recorded and so stays eligible indefinitely.
DO $p$
DECLARE
  v_uid uuid; v_secret text; v_req bigint; v_prev bigint := 69943;
  v_status int; v_content text; v_j jsonb; i int;
  v_checked int; v_rep int; v_thr int; v_exc int; v_ok int; v_unver int;
  v_remaining int; v_recorded int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  FOR i IN 1..60 LOOP
    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = v_prev;
    EXIT WHEN v_status IS NOT NULL;
    PERFORM pg_sleep(3);
  END LOOP;

  IF v_status IS NULL THEN
    RAISE NOTICE '>>> pass fired as request % has not landed. NOT firing another.', v_prev;
    RAISE NOTICE '    Durable state is intact either way -- check';
    RAISE NOTICE '    collapsed_order_checks for what was settled.';
    RETURN;
  END IF;
  IF v_status <> 200 THEN
    RAISE NOTICE '>>> request % returned HTTP %. NOT firing another.', v_prev, v_status;
    RAISE NOTICE '    body: %', left(COALESCE(v_content,''),400);
    RETURN;
  END IF;

  v_j := v_content::jsonb;
  v_checked := COALESCE((v_j->>'checked')::int,0);
  v_rep     := COALESCE((v_j->>'repaired')::int,0);
  v_thr     := COALESCE((v_j->>'throttled')::int,0);
  v_exc     := COALESCE((v_j->>'exceeds_money_estimate')::int,0);
  v_ok      := COALESCE((v_j->>'already_correct')::int,0);
  v_unver   := COALESCE((v_j->>'unverifiable')::int,0);

  RAISE NOTICE '############ PREVIOUS PASS (request %) ############', v_prev;
  RAISE NOTICE '   checked % | REPAIRED % | already_correct %',
    v_checked, v_rep, v_ok;
  RAISE NOTICE '   throttled % | unverifiable % | exceeds_money_estimate %',
    v_thr, v_unver, v_exc;
  RAISE NOTICE '   checks_recorded: %', v_j->>'checks_recorded';

  -- durable truth, independent of the response
  SELECT count(*) INTO v_recorded FROM public.collapsed_order_checks
   WHERE user_id = v_uid;
  SELECT count(*) INTO v_remaining
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);
  RAISE NOTICE '';
  RAISE NOTICE '   DURABLE: % verdicts recorded in total | % candidates left',
    v_recorded, v_remaining;
  FOR i IN 1..1 LOOP
    DECLARE rr record;
    BEGIN
      FOR rr IN SELECT outcome, count(*) AS n
                FROM public.collapsed_order_checks
                WHERE user_id = v_uid GROUP BY 1 ORDER BY 2 DESC
      LOOP RAISE NOTICE '      % | %', rpad(rr.outcome,24), rr.n; END LOOP;
    END;
  END LOOP;

  ------------------------------------------------------------------
  -- RULE 3: stop if throttling dominated this pass
  ------------------------------------------------------------------
  IF v_checked > 0 AND v_thr * 2 > v_checked THEN
    RAISE NOTICE '';
    RAISE NOTICE '>>> RULE 3: % of % calls were throttled. STOPPING.', v_thr, v_checked;
    RAISE NOTICE '    Not firing another pass. % candidates remain and every', v_remaining;
    RAISE NOTICE '    one is still eligible, because a throttle is never';
    RAISE NOTICE '    recorded. Resume in a quieter window.';
    RETURN;
  END IF;

  IF v_remaining = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> shortlist empty. Every candidate has a verdict. Done.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'marketplace', NULL,
                               'limit', 45, 'offset', 0, 'dry_run', false),
    timeout_milliseconds := 118000
  ) INTO v_req;
  RAISE NOTICE '';
  RAISE NOTICE '   next APPLY pass fired at % -- request %', clock_timestamp(), v_req;
END
$p$;
