-- READ-ONLY. February's fresh dry run, checked against the agreed stop
-- conditions. Fails loudly rather than proceeding if any trips.
DO $p$
DECLARE v_body jsonb; v_rl int; v_ca int; v_claw numeric; v_api numeric; v_st numeric; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_body := public.repull_find_report('2026-02-01'::date, false, NULL, true);

  IF v_body IS NULL THEN
    RAISE NOTICE 'NOT LANDED YET -- no February report with a multiset. Re-read shortly.';
    RETURN;
  END IF;

  v_rl   := (v_body->>'rate_limit_hits')::int;
  v_ca   := (v_body->>'api_items_via_catchall')::int;
  v_claw := (v_body->>'api_clawback_total')::numeric;
  v_api  := (v_body->>'api_signed_total')::numeric;
  v_st   := (v_body->>'stored_signed_total')::numeric;

  RAISE NOTICE '== FEBRUARY, fresh dry run ==';
  RAISE NOTICE '   items % | pages % | elapsed % ms',
    v_body->>'api_items', v_body->>'pages', v_body->>'elapsed_ms';
  RAISE NOTICE '   rate-limit hits % | catch-all % | types %',
    v_rl, v_ca, v_body->'api_catchall_types';
  RAISE NOTICE '   stored % -> api % | net % | clawbacks % | residual %',
    v_st, v_api, round(v_api-v_st,2), v_claw, round((v_api-v_st)-v_claw,2);

  RAISE NOTICE '';
  RAISE NOTICE '== STOP CONDITIONS ==';
  RAISE NOTICE '   rate-limit hits = 0 ?  % (%)', (v_rl = 0), v_rl;
  RAISE NOTICE '   catch-all = 0 ?        % (%)', (v_ca = 0), v_ca;
  RAISE NOTICE '   clawbacks = -227.95 ?  % (%)', (v_claw = -227.95), v_claw;

  IF v_rl <> 0 OR v_ca <> 0 OR v_claw <> -227.95 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> STOP. Not taking the backup. Reporting instead.';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '   ALL CLEAR -- safe to back up and apply February.';
  END IF;
END
$p$;
