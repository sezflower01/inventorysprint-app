-- PROBE (read-only): SprintPrint.exe IS in the access bucket -- 83 MB, updated
-- 2026-08-11. So "object not found" is not a missing file.
--
-- The access bucket is private, and Supabase Storage deliberately reports an
-- RLS denial as "Object not found" rather than "forbidden", so it does not leak
-- whether a file exists. A SELECT policy the session no longer satisfies
-- produces exactly the message the seller is seeing.
--
-- Read the policies on storage.objects and see which ones cover this bucket.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'owner user id: %', v_uid;

  RAISE NOTICE '';
  RAISE NOTICE '======== policies on storage.objects ========';
  FOR r IN
    SELECT policyname, cmd, roles::text AS roles,
           COALESCE(qual, '(none)') AS using_expr,
           COALESCE(with_check, '(none)') AS check_expr
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    ORDER BY cmd, policyname
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   [%] %  roles=%', r.cmd, r.policyname, r.roles;
    RAISE NOTICE '        USING %', left(r.using_expr, 200);
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   NO policies on storage.objects at all';
    RAISE NOTICE '   -> with RLS enabled that denies every authenticated read';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== is RLS actually on? ========';
  FOR r IN
    SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname IN ('objects','buckets')
  LOOP
    RAISE NOTICE '   storage.%  rls=%  forced=%', rpad(r.relname,9), r.rls_enabled, r.forced;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== which policies mention the access bucket? ========';
  v_n := 0;
  FOR r IN
    SELECT policyname, cmd, COALESCE(qual,'') || ' ' || COALESCE(with_check,'') AS expr
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND (COALESCE(qual,'') || COALESCE(with_check,'')) ILIKE '%access%'
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   [%] %', r.cmd, r.policyname;
    RAISE NOTICE '        %', left(r.expr, 260);
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   none -- no policy names the access bucket';
    RAISE NOTICE '   -> a signed-URL request from an authenticated user is refused,';
    RAISE NOTICE '      and Storage reports that refusal as "Object not found"';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== who owns the SprintPrint.exe row? ========';
  FOR r IN
    SELECT o.name, o.owner, o.bucket_id,
           (o.owner = v_uid) AS owned_by_this_user,
           o.created_at, o.updated_at
    FROM storage.objects o
    WHERE o.bucket_id = 'access' AND o.name = 'SprintPrint.exe'
  LOOP
    RAISE NOTICE '   owner=%  matches this user=%', r.owner, r.owned_by_this_user;
    RAISE NOTICE '   created % | updated %', r.created_at, r.updated_at;
  END LOOP;
END
$probe$;
