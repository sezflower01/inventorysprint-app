DO $p$
DECLARE r record; v_body jsonb; v_id bigint;
        v_claw numeric := 0; v_claw_n int := 0; v_done int := 0;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[21165::bigint, 21190, 21191, 21192, 21193] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    IF v_body IS NULL OR v_body ? 'error' THEN
      RAISE NOTICE '   request %: % ', v_id,
        CASE WHEN v_body IS NULL THEN 'pending' ELSE 'ERROR '||(v_body->>'error') END;
      CONTINUE;
    END IF;
    v_done := v_done + 1;
    FOR r IN
      SELECT (value->>'items')::int AS items, (value->>'signed_total')::numeric AS tot
      FROM jsonb_each(v_body->'by_adjustment_type')
      WHERE upper(key) LIKE '%COMPENSATED_CLAWBACK%'
    LOOP
      v_claw := v_claw + r.tot; v_claw_n := v_claw_n + r.items;
      RAISE NOTICE '   % .. % | % clawbacks | $%',
        left(v_body->'window'->>'posted_after',10),
        left(v_body->'window'->>'posted_before',10), r.items, r.tot;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== CLAWBACKS, last ~90 days ==';
  RAISE NOTICE '   API slices complete: % of 5', v_done;
  RAISE NOTICE '   2026-07-24 .. 2026-10-01 : % events, $%', v_claw_n, round(v_claw,2);
  RAISE NOTICE '   2026-10 (stored by resync):  10 events, $-108.27';
  RAISE NOTICE '   ------------------------------------------';
  RAISE NOTICE '   TOTAL ~90 days: % events, $%', v_claw_n + 10, round(v_claw - 108.27, 2);
END
$p$;
