-- Read the October second half, then fire ONE August slice.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_body jsonb; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';

  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 26719;
  IF v_body IS NULL THEN RAISE NOTICE '== 26719 (Oct 16..23): pending ==';
  ELSIF v_body ? 'error' THEN RAISE NOTICE '== 26719 ERROR: % ==', left(v_body->>'error',200);
  ELSE
    RAISE NOTICE '== Oct 16..23 | pages % | items % ==',
      v_body->>'pages', v_body->>'adjustment_items';
    FOR r IN SELECT key AS atype, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS tot
             FROM jsonb_each(v_body->'by_adjustment_type') ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP RAISE NOTICE '   % | % | $%', rpad(r.atype,32), lpad(r.n::text,4), r.tot; END LOOP;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
      'posted_after','2026-08-01T00:00:00Z', 'posted_before','2026-08-16T00:00:00Z',
      'summary_only', true),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '';
  RAISE NOTICE '== Aug 1..16 -> request % ==', v_req;
END
$p$;
