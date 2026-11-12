-- READ ONLY. Pre-work for the sync-family credential changes.
--
-- Measures three things that the change depends on and that cannot be read off
-- the source:
--
--   1. Which pg_cron jobs send which authentication header. This has to be
--      known BEFORE tightening any auth check: a check added to a job that
--      does not send what the check expects kills the job silently, with
--      pg_cron still reporting success. That trap is documented in CLAUDE.md
--      and has cost a debugging cycle here before.
--
--   2. What the inventory rows belonging to a second account actually contain
--      -- which of the operator's business columns travelled with them.
--
--   3. Whether anything seeds a new account from existing data: a trigger on
--      auth.users, or a column default.
--
-- Findings were reported to the operator directly. Security specifics are
-- deliberately not written down in a public repository.
DO $p$
DECLARE
  v_owner uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  v_other uuid;
  r record; n bigint;
BEGIN
  SELECT id INTO v_other FROM auth.users WHERE id::text LIKE 'e697c7c7%';

  RAISE NOTICE '=== 1. cron jobs for the sync family, and the auth header each sends ===';
  FOR r IN
    SELECT jobname, schedule, active,
           (command ILIKE '%x-internal-secret%') AS sends_secret,
           (command ILIKE '%service_role%' OR command ILIKE '%Authorization%') AS sends_bearer,
           substring(command from 'functions/v1/([a-z0-9-]+)') AS fn
    FROM cron.job
    WHERE command ILIKE '%functions/v1/sync-%' OR command ILIKE '%bulk-live-verify%'
       OR command ILIKE '%poll-fbm%' OR command ILIKE '%resolve-unmapped%'
    ORDER BY 6, 1
  LOOP
    RAISE NOTICE '  fn=%  job=%  sched=%  active=%  x-internal-secret=%  bearer=%',
      rpad(COALESCE(r.fn,'?'),24), rpad(r.jobname,30), r.schedule, r.active,
      r.sends_secret, r.sends_bearer;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 2. what the copy carried: operator business data in those rows ===';
  -- Column-driven, because `inventory` has no unit_cost: this project swaps the
  -- meaning of cost/amount between inventory and created_listings (the
  -- cost-contract inversion), so assuming a column name is how the first
  -- attempt at this probe died. Ask the catalogue, then count NOT NULL.
  FOR r IN
    SELECT column_name AS c, data_type AS d
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory'
      AND column_name ~* 'cost|price|brand|title|fnsku|supplier|profit|roi|margin'
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.inventory WHERE user_id = $1 AND %I IS NOT NULL', r.c)
      INTO n USING v_other;
    IF n > 0 THEN
      RAISE NOTICE '  populated: % (%) -> % rows', rpad(r.c,24), rpad(r.d,18), n;
    END IF;
  END LOOP;

  RAISE NOTICE '=== 2b. every other user-scoped table, rows for e697c7c7 ===';
  FOR r IN
    SELECT c.table_name AS t
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'user_id'
      AND EXISTS (SELECT 1 FROM information_schema.tables t2
                  WHERE t2.table_schema='public' AND t2.table_name=c.table_name
                    AND t2.table_type='BASE TABLE')
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE user_id = %L', r.t, v_other) INTO n;
    IF n > 0 THEN RAISE NOTICE '  *** % : % row(s)', rpad(r.t,34), n; END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 3. triggers on auth.users (would seed a new account) ===';
  FOR r IN
    SELECT t.tgname, p.proname, n.nspname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE ns.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal
    ORDER BY 1
  LOOP
    RAISE NOTICE '  trigger % -> %.%', rpad(r.tgname,34), r.nspname, r.proname;
  END LOOP;

  RAISE NOTICE '  -- any of those functions touch inventory/listings? --';
  FOR r IN
    SELECT p.proname,
           (pg_get_functiondef(p.oid) ILIKE '%inventory%') AS touches_inventory,
           (pg_get_functiondef(p.oid) ILIKE '%created_listings%') AS touches_listings
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE ns.nspname='auth' AND c.relname='users' AND NOT t.tgisinternal
  LOOP
    RAISE NOTICE '    % inventory=% listings=%', rpad(r.proname,30), r.touches_inventory, r.touches_listings;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 4. is e697c7c7 a real user or a test account? ===';
  FOR r IN
    SELECT left(id::text,8) AS u, created_at::date AS created,
           last_sign_in_at::date AS last_seen,
           (email_confirmed_at IS NOT NULL) AS confirmed,
           split_part(email,'@',2) AS domain,
           (raw_user_meta_data->>'full_name') AS name
    FROM auth.users WHERE id = v_other
  LOOP
    RAISE NOTICE '  user % created % last_seen % confirmed % domain=% name=%',
      r.u, r.created, COALESCE(r.last_seen::text,'never'), r.confirmed,
      COALESCE(r.domain,'?'), COALESCE(r.name,'(none)');
  END LOOP;
END $p$;
