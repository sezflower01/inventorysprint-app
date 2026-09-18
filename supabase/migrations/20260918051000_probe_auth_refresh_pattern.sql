-- READ-ONLY PROBE. Creates nothing, changes nothing. Event types and counts
-- only -- no tokens are read.
-- Signed-in pages stall on "Loading..." while the DB is idle and the public
-- site loads fine. Supabase has an open incident (401s from JWT rejections,
-- stale gateway clock). Does this user's auth activity show a refresh loop
-- or failures right now?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '== auth events for this user, last 2 hours, per 10 minutes ==';
  FOR r IN SELECT to_char(date_trunc('hour', created_at) + floor(date_part('minute', created_at) / 10) * interval '10 min', 'HH24:MI') AS bucket,
                  payload->>'action' AS action, count(*) AS n
           FROM auth.audit_log_entries
           WHERE created_at > now() - interval '2 hours'
             AND (payload->>'actor_id' = v_uid::text OR payload->'traits'->>'user_id' = v_uid::text)
           GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '  % % x%', r.bucket, r.action, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== sessions ==';
  FOR r IN SELECT created_at, updated_at, refreshed_at, not_after, left(COALESCE(user_agent,''), 60) AS ua
           FROM auth.sessions WHERE user_id = v_uid ORDER BY updated_at DESC NULLS LAST LIMIT 6 LOOP
    RAISE NOTICE '  created % | updated % | refreshed % | ua %', r.created_at, r.updated_at, r.refreshed_at, r.ua;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== refresh tokens issued per 10 min, last 2 hours ==';
  FOR r IN SELECT to_char(date_trunc('hour', created_at) + floor(date_part('minute', created_at) / 10) * interval '10 min', 'HH24:MI') AS bucket,
                  count(*) AS n, count(*) FILTER (WHERE revoked) AS revoked
           FROM auth.refresh_tokens WHERE user_id = v_uid::text AND created_at > now() - interval '2 hours'
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % issued % (revoked %)', r.bucket, r.n, r.revoked;
  END LOOP;
EXCEPTION WHEN undefined_column OR undefined_table THEN
  RAISE NOTICE 'auth schema shape differs: %', SQLERRM;
END
$p$;
