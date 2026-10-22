-- READ-ONLY. The full-month slices (21166, 21167) never returned a response
-- row -- roughly 60 pages each is too long for pg_net to hold. The 8-day slice
-- (21165) finished in 13 pages, so ~1.6 pages/day: half-month slices land
-- comfortably.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';

  FOR r IN
    SELECT * FROM (VALUES
      ('2026-08-01T00:00:00Z','2026-08-16T00:00:00Z'),
      ('2026-08-16T00:00:00Z','2026-09-01T00:00:00Z'),
      ('2026-09-01T00:00:00Z','2026-09-16T00:00:00Z'),
      ('2026-09-16T00:00:00Z','2026-10-01T00:00:00Z')
    ) AS v(a, b)
  LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_id', v_uid, 'posted_after', r.a,
                                 'posted_before', r.b, 'summary_only', true),
      timeout_milliseconds := 60000
    ) INTO v_req;
    RAISE NOTICE '== % .. % -> request % ==', left(r.a,10), left(r.b,10), v_req;
  END LOOP;
END
$p$;
