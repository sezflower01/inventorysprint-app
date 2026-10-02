-- READ-ONLY PROBE. Did fresh isolates bring the repricer back?
--
-- The credentials were already correct and accepted by Amazon; what kept the
-- repricer idle was per-isolate credential memos with no expiry, holding the
-- bad app from during the outage. The four credential-consuming functions have
-- just been redeployed, which cycles their isolates, and the memos now carry a
-- 60 s TTL so this cannot outlive a fix again.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== SP-API gate ==';
  FOR r IN SELECT operation, last_called_at, now() - last_called_at AS since
           FROM public.sp_api_rate_limit_state WHERE user_id = v_uid
           ORDER BY last_called_at DESC NULLS LAST LIMIT 4 LOOP
    RAISE NOTICE '  % | % | % ago', r.operation, r.last_called_at, r.since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== applies and evaluations, newest first ==';
  FOR r IN SELECT max(last_applied_at) AS last_apply,
                  max(last_evaluated_at) AS last_eval,
                  max(last_dispatch_at) AS last_dispatch,
                  max(last_sp_api_check_at) AS last_spapi_check
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND marketplace = 'US' LOOP
    RAISE NOTICE '  apply % | eval % | dispatch % | sp-api check %',
      r.last_apply, r.last_eval, r.last_dispatch, r.last_spapi_check;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== applies per minute (last 10 min) ==';
  FOR r IN SELECT date_trunc('minute', last_applied_at) AS m, count(*) AS n
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND last_applied_at > now() - interval '10 minutes'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : %', r.m, r.n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  nothing yet'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== sales sync, which the seller can already see moving ==';
  FOR r IN SELECT count(*) AS orders_24h, max(created_at) AS newest_row
           FROM public.sales_orders
           WHERE user_id = v_uid AND created_at > now() - interval '24 hours' LOOP
    RAISE NOTICE '  % order rows written in 24 h | newest %', r.orders_24h, r.newest_row;
  END LOOP;
END
$p$;
