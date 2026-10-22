-- READ-ONLY. Item 2 (October API vs stored) and item 4 (Aug/Sep sizing).
DO $p$
DECLARE v_uid uuid; r record; v_body jsonb; v_id bigint;
        v_oct_items int := 0; v_oct_signed numeric := 0; v_oct_claw numeric := 0; v_oct_claw_n int := 0;
        v_done int := 0;
        v_stored_items int; v_stored_signed numeric; v_stored_claw numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== ITEM 2: OCTOBER, live API slices ==';
  FOREACH v_id IN ARRAY ARRAY[26669::bigint, 26670] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    IF v_body IS NULL THEN RAISE NOTICE '   %: pending', v_id; CONTINUE; END IF;
    IF v_body ? 'error' THEN RAISE NOTICE '   %: ERROR %', v_id, v_body->>'error'; CONTINUE; END IF;
    v_done := v_done + 1;
    RAISE NOTICE '   % .. % | pages % | items %',
      left(v_body->'window'->>'posted_after',10), left(v_body->'window'->>'posted_before',10),
      v_body->>'pages', v_body->>'adjustment_items';
    v_oct_items := v_oct_items + COALESCE((v_body->>'adjustment_items')::int,0);
    FOR r IN
      SELECT key AS atype, (value->>'items')::int AS items, (value->>'signed_total')::numeric AS tot
      FROM jsonb_each(v_body->'by_adjustment_type')
    LOOP
      v_oct_signed := v_oct_signed + r.tot;
      IF upper(r.atype) LIKE '%COMPENSATED_CLAWBACK%' THEN
        v_oct_claw := v_oct_claw + r.tot; v_oct_claw_n := v_oct_claw_n + r.items;
      END IF;
      RAISE NOTICE '      % | % | $%', rpad(r.atype,32), lpad(r.items::text,4), r.tot;
    END LOOP;
  END LOOP;

  IF v_done = 2 THEN
    SELECT count(*),
           round(sum(COALESCE(reimbursements,0)+COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                    +COALESCE(reversal_reimbursement,0)+COALESCE(free_replacement_refund_items,0)
                    +COALESCE(compensated_clawback,0)),2),
           round(sum(COALESCE(compensated_clawback,0)),2)
      INTO v_stored_items, v_stored_signed, v_stored_claw
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type='adjustment'
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31';

    RAISE NOTICE '';
    RAISE NOTICE '   == COLLISION CHECK ==';
    RAISE NOTICE '   API    : % items | signed $% | clawback $% (%)',
      v_oct_items, round(v_oct_signed,2), round(v_oct_claw,2), v_oct_claw_n;
    RAISE NOTICE '   STORED : % rows  | signed $% | clawback $%',
      v_stored_items, v_stored_signed, v_stored_claw;
    RAISE NOTICE '   DELTA  : % items | $% money',
      v_stored_items - v_oct_items, round(v_stored_signed - round(v_oct_signed,2), 2);
    IF v_stored_items < v_oct_items THEN
      RAISE NOTICE '   >>> % API items did NOT become rows -- collisions merged them',
        v_oct_items - v_stored_items;
    END IF;
  ELSE
    RAISE NOTICE '   (October slices incomplete: % of 2)', v_done;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 4: AUG/SEP clawback sizing ==';
  FOREACH v_id IN ARRAY ARRAY[21190::bigint, 21191, 21192, 21193] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    IF v_body IS NULL THEN RAISE NOTICE '   %: pending', v_id; CONTINUE; END IF;
    IF v_body ? 'error' THEN RAISE NOTICE '   %: ERROR %', v_id, v_body->>'error'; CONTINUE; END IF;
    RAISE NOTICE '   % .. % | items %',
      left(v_body->'window'->>'posted_after',10), left(v_body->'window'->>'posted_before',10),
      v_body->>'adjustment_items';
    FOR r IN
      SELECT key AS atype, (value->>'items')::int AS items, (value->>'signed_total')::numeric AS tot
      FROM jsonb_each(v_body->'by_adjustment_type')
      ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP
      RAISE NOTICE '      % | % | $%', rpad(r.atype,32), lpad(r.items::text,4), r.tot;
    END LOOP;
  END LOOP;
END
$p$;
