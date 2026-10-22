-- READ-ONLY. Item 2 needs October's adjustment count and signed sum straight
-- from the API to compare against what we stored, so the key-collision loss can
-- be measured. Half-month slices because a full month never returns (~60 pages).
-- Also reads the Aug/Sep slices fired earlier.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; r record; v_body jsonb; v_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';

  RAISE NOTICE '== firing October slices for the collision check ==';
  FOR r IN
    SELECT * FROM (VALUES
      ('2026-10-01T00:00:00Z','2026-10-16T00:00:00Z'),
      ('2026-10-16T00:00:00Z','2026-11-01T00:00:00Z')
    ) AS v(a, b)
  LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_id', v_uid, 'posted_after', r.a,
                                 'posted_before', r.b, 'summary_only', true),
      timeout_milliseconds := 60000
    ) INTO v_req;
    RAISE NOTICE '   % .. % -> request %', left(r.a,10), left(r.b,10), v_req;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== Aug/Sep slices fired earlier (21190-21193) ==';
  FOREACH v_id IN ARRAY ARRAY[21190::bigint, 21191, 21192, 21193] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    IF v_body IS NULL THEN RAISE NOTICE '   %: pending', v_id; CONTINUE; END IF;
    IF v_body ? 'error' THEN RAISE NOTICE '   %: ERROR %', v_id, v_body->>'error'; CONTINUE; END IF;
    RAISE NOTICE '   % | % .. % | pages % | items %', v_id,
      left(v_body->'window'->>'posted_after',10), left(v_body->'window'->>'posted_before',10),
      v_body->>'pages', v_body->>'adjustment_items';
    FOR r IN
      SELECT key AS atype, (value->>'items')::int AS items,
             (value->>'signed_total')::numeric AS tot, (value->>'negatives')::int AS negs
      FROM jsonb_each(v_body->'by_adjustment_type')
      ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP
      RAISE NOTICE '      % | % items | $% | % neg',
        rpad(r.atype,32), lpad(r.items::text,4), lpad(r.tot::text,10), r.negs;
    END LOOP;
  END LOOP;
END
$p$;
