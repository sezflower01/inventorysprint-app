DO $p$
DECLARE v_body jsonb; r record;
BEGIN
  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 26773;
  IF v_body IS NULL THEN RAISE NOTICE 'Sep 16..Oct 1: still pending';
  ELSIF v_body ? 'error' THEN RAISE NOTICE 'Sep 16..Oct 1 ERROR: %', left(v_body->>'error',250);
  ELSE
    RAISE NOTICE '== Sep 16 .. Oct 1 | items % ==', v_body->>'adjustment_items';
    FOR r IN SELECT key AS a, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS t
             FROM jsonb_each(v_body->'by_adjustment_type') ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP RAISE NOTICE '   % | % | $%', rpad(r.a,32), lpad(r.n::text,4), r.t; END LOOP;
  END IF;
END
$p$;
