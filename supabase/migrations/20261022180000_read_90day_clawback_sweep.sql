-- READ-ONLY. Read the three 90-day slices (21165, 21166, 21167).
DO $p$
DECLARE r record; v_body jsonb; v_id bigint;
        v_tot_items int := 0; v_tot_claw numeric := 0; v_tot_claw_n int := 0;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[21165::bigint, 21166, 21167] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    RAISE NOTICE '';
    IF v_body IS NULL THEN
      RAISE NOTICE '== request %: no response yet ==', v_id;
      CONTINUE;
    END IF;
    IF v_body ? 'error' THEN
      RAISE NOTICE '== request %: ERROR % ==', v_id, v_body->>'error';
      CONTINUE;
    END IF;

    RAISE NOTICE '== request % | % .. % | pages % | items % ==',
      v_id, left(v_body->'window'->>'posted_after',10),
      left(v_body->'window'->>'posted_before',10),
      v_body->>'pages', v_body->>'adjustment_items';
    v_tot_items := v_tot_items + COALESCE((v_body->>'adjustment_items')::int, 0);

    FOR r IN
      SELECT key AS atype,
             (value->>'items')::int AS items,
             (value->>'signed_total')::numeric AS signed_total,
             (value->>'negatives')::int AS negs
      FROM jsonb_each(v_body->'by_adjustment_type')
      ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP
      RAISE NOTICE '   % | % items | signed % | % negative',
        rpad(r.atype,32), lpad(r.items::text,4), lpad(r.signed_total::text,10), r.negs;
      IF upper(r.atype) LIKE '%COMPENSATED_CLAWBACK%' THEN
        v_tot_claw := v_tot_claw + r.signed_total;
        v_tot_claw_n := v_tot_claw_n + r.items;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '==========================================================';
  RAISE NOTICE '== CLAWBACK HISTORY SIZING ==';
  RAISE NOTICE '   2026-07-24 .. 2026-10-01 (from the API): % events, $%',
    v_tot_claw_n, round(v_tot_claw,2);
  RAISE NOTICE '   2026-10 (already stored by the resync):   10 events, $-108.27';
  RAISE NOTICE '   ----------------------------------------------';
  RAISE NOTICE '   ~90 day total: % events, $%',
    v_tot_claw_n + 10, round(v_tot_claw + (-108.27), 2);
  RAISE NOTICE '   adjustment items scanned across the 3 slices: %', v_tot_items;
END
$p$;
