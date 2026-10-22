-- READ-ONLY. Item 3: how many COMPENSATED_CLAWBACK events exist in the last 90
-- days, so the history can be sized before touching any other month.
--
-- Split into month slices: a 90-day window is roughly 180 pages of financial
-- events, which would exceed the pg_net timeout in one call. October is
-- already stored (10 clawbacks, -108.27) so only the earlier slices are
-- fetched here. summary_only keeps each payload small.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';

  FOR r IN
    SELECT * FROM (VALUES
      ('2026-07-24T00:00:00Z','2026-08-01T00:00:00Z'),
      ('2026-08-01T00:00:00Z','2026-09-01T00:00:00Z'),
      ('2026-09-01T00:00:00Z','2026-10-01T00:00:00Z')
    ) AS v(a, b)
  LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object(
        'user_id', v_uid,
        'posted_after', r.a,
        'posted_before', r.b,
        'summary_only', true
      ),
      timeout_milliseconds := 115000
    ) INTO v_req;
    RAISE NOTICE '== slice % .. % -> request % ==', left(r.a,10), left(r.b,10), v_req;
  END LOOP;
END
$p$;
