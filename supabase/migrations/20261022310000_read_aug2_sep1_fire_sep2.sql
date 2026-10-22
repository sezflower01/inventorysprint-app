DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_body jsonb; r record; v_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';

  FOREACH v_id IN ARRAY ARRAY[26749::bigint, 26750] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    RAISE NOTICE '';
    IF v_body IS NULL THEN RAISE NOTICE '== %: pending ==', v_id; CONTINUE; END IF;
    IF v_body ? 'error' THEN RAISE NOTICE '== % ERROR: % ==', v_id, left(v_body->>'error',200); CONTINUE; END IF;
    RAISE NOTICE '== % .. % | items % ==',
      left(v_body->'window'->>'posted_after',10), left(v_body->'window'->>'posted_before',10),
      v_body->>'adjustment_items';
    FOR r IN SELECT key AS a, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS t
             FROM jsonb_each(v_body->'by_adjustment_type') ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP RAISE NOTICE '   % | % | $%', rpad(r.a,32), lpad(r.n::text,4), r.t; END LOOP;
  END LOOP;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
      'posted_after','2026-09-16T00:00:00Z','posted_before','2026-10-01T00:00:00Z','summary_only',true),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '';
  RAISE NOTICE '== Sep 16..Oct 1 -> request % ==', v_req;
END
$p$;
