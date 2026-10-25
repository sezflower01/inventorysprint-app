-- READ-ONLY. May's fresh dry run against the agreed stop conditions.
DO $p$
DECLARE v_body jsonb; v_rl int; v_ca int; v_claw numeric; v_api numeric; v_st numeric;
BEGIN
  v_body := public.repull_find_report('2026-05-01'::date, false, NULL, true);
  IF v_body IS NULL THEN
    RAISE NOTICE 'NOT LANDED YET -- re-read shortly.'; RETURN;
  END IF;

  v_rl   := (v_body->>'rate_limit_hits')::int;
  v_ca   := (v_body->>'api_items_via_catchall')::int;
  v_claw := (v_body->>'api_clawback_total')::numeric;
  v_api  := (v_body->>'api_signed_total')::numeric;
  v_st   := (v_body->>'stored_signed_total')::numeric;

  RAISE NOTICE '== MAY, fresh dry run ==';
  RAISE NOTICE '   items % | pages % | elapsed % ms | captured %',
    v_body->>'api_items', v_body->>'pages', v_body->>'elapsed_ms', v_body->>'month';
  RAISE NOTICE '   rate-limit hits % | catch-all % | types %', v_rl, v_ca, v_body->'api_catchall_types';
  RAISE NOTICE '   stored % -> api % | net % | clawbacks % | residual %',
    v_st, v_api, round(v_api-v_st,2), v_claw, round((v_api-v_st)-v_claw,2);

  RAISE NOTICE '';
  RAISE NOTICE '== STOP CONDITIONS (recorded: 0 hits, catch-all 0, clawbacks -187.96) ==';
  RAISE NOTICE '   rate-limit hits = 0 ? % (%)', (v_rl = 0), v_rl;
  RAISE NOTICE '   catch-all = 0 ?       % (%)', (v_ca = 0), v_ca;
  RAISE NOTICE '   clawbacks = -187.96 ? % (%)', (v_claw = -187.96), v_claw;

  IF v_rl <> 0 OR v_ca <> 0 OR v_claw <> -187.96 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> STOP. No backup, no apply.';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '   ALL CLEAR -- proceeding to backup and apply.';
  END IF;
END
$p$;
