DO $p$
DECLARE v_body jsonb; r record; v_id bigint;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[26733::bigint, 26732] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    RAISE NOTICE '';
    IF v_body IS NULL THEN RAISE NOTICE '== %: pending ==', v_id; CONTINUE; END IF;
    IF v_body ? 'error' THEN RAISE NOTICE '== % ERROR: % ==', v_id, left(v_body->>'error',250); CONTINUE; END IF;
    RAISE NOTICE '== % | % .. % | pages % | items % ==', v_id,
      left(v_body->'window'->>'posted_after',10), left(v_body->'window'->>'posted_before',16),
      v_body->>'pages', v_body->>'adjustment_items';
    FOR r IN SELECT key AS atype, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS tot
             FROM jsonb_each(v_body->'by_adjustment_type') ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP RAISE NOTICE '   % | % | $%', rpad(r.atype,32), lpad(r.n::text,4), r.tot; END LOOP;
  END LOOP;
END
$p$;
