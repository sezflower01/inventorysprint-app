-- Read-only: what would a brand-new account actually be able to do?
DO $$
DECLARE r RECORD; v_users bigint; v_with_access bigint; v_trig bigint;
BEGIN
  SELECT count(*) INTO v_users FROM auth.users;
  SELECT count(DISTINCT user_id) INTO v_with_access FROM public.user_module_access;
  SELECT count(*) INTO v_trig FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal;
  RAISE NOTICE 'accounts=% | with module access rows=% | triggers on auth.users=%',
    v_users, v_with_access, v_trig;

  FOR r IN SELECT module, action, count(*) AS n
             FROM public.user_module_access GROUP BY module, action
            ORDER BY module LIMIT 12
  LOOP
    RAISE NOTICE '  granted: % / % to % account(s)', r.module, r.action, r.n;
  END LOOP;

  FOR r IN SELECT t.tgname FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal
  LOOP
    RAISE NOTICE '  auth.users trigger: %', r.tgname;
  END LOOP;
END $$;
