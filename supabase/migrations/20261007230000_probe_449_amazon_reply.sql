-- READ-ONLY. Read the reply to request 46501 (the Amazon status sample).
DO $p$
DECLARE r record; v_body jsonb;
BEGIN
  FOR r IN SELECT id, status_code, content, created FROM net._http_response
           WHERE id = 46501 LOOP
    RAISE NOTICE 'http % at %', r.status_code, r.created;
    BEGIN v_body := r.content::jsonb; EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'non-JSON reply: %', left(r.content, 400); RETURN; END;
  END LOOP;
  IF v_body IS NULL THEN RAISE NOTICE '(no reply yet for request 46501)'; RETURN; END IF;

  RAISE NOTICE 'readOnly=% requested=%', v_body->>'readOnly', v_body->>'requested';
  RAISE NOTICE 'tally: %', v_body->'tally';
  RAISE NOTICE '';
  RAISE NOTICE 'order | amazon says | shipped/unshipped | total | last update';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v_body->'rows','[]'::jsonb)) AS e(v) LOOP
    RAISE NOTICE '  % | % | %/% | % % | %',
      r.v->>'order_id',
      rpad(COALESCE(r.v->>'amazon_status', 'http ' || COALESCE(r.v->>'http','?')), 12),
      COALESCE(r.v->>'items_shipped','-'), COALESCE(r.v->>'items_unshipped','-'),
      COALESCE(r.v->>'order_total','-'), COALESCE(r.v->>'currency',''),
      COALESCE(r.v->>'last_update','-');
  END LOOP;
END
$p$;
