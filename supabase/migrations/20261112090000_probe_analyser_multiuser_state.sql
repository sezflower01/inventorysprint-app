-- Can the extension analyser run without the user connecting Amazon, and is
-- anyone already doing it? READ ONLY. Counts and roles only -- no email
-- addresses besides the account owner's own, which is already known here.
--
-- Code reading established the mechanism: every SP-API call in
-- fetch-listing-snapshot, asin-dimensions and check-fba-listing-eligibility
-- resolves its token as `userAuth?.refresh_token || Deno.env.get(
-- 'SPAPI_REFRESH_TOKEN')`, and check-fba-listing-eligibility does the same for
-- seller_id with the comment "else env default". So a user with no
-- seller_authorizations row does not get an error -- they get answers computed
-- against the OWNER's Amazon account. listing-seller-count is the exception and
-- returns 400.
--
-- What the database has to say:
--   1. How many accounts exist, and how many have their own SP-API connection.
--   2. Who is granted the analyser module (module-access-guard gates
--      fetch-listing-snapshot), i.e. who could already be doing this.
--   3. Whether non-owner users have analyser-shaped activity on record.

DO $p$
DECLARE v_uid uuid; r record; n bigint; v_has boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT COUNT(*) INTO n FROM auth.users;
  RAISE NOTICE 'auth.users total: %', n;

  SELECT COUNT(*) INTO n FROM public.seller_authorizations WHERE is_active = true;
  RAISE NOTICE 'active seller_authorizations rows: %', n;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 1. users WITH their own SP-API connection ===';
  FOR r IN
    SELECT user_id, COUNT(*) AS marketplaces, (user_id = v_uid) AS is_owner
    FROM public.seller_authorizations
    WHERE is_active = true
    GROUP BY 1 ORDER BY 3 DESC, 2 DESC
  LOOP
    RAISE NOTICE 'user %  marketplaces %  owner=%',
      left(r.user_id::text, 8), r.marketplaces, r.is_owner;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 2. users with NO connection (these fall back to the owner token) ===';
  FOR r IN
    SELECT u.id, u.created_at::date AS created, (u.id = v_uid) AS is_owner
    FROM auth.users u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.seller_authorizations sa
      WHERE sa.user_id = u.id AND sa.is_active = true)
    ORDER BY u.created_at
  LOOP
    RAISE NOTICE 'user %  created %  owner=%', left(r.id::text, 8), r.created, r.is_owner;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 3. roles on record ===';
  FOR r IN
    SELECT role::text AS role, COUNT(*) AS n FROM public.user_roles GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE 'role % : % user(s)', rpad(r.role,10), r.n;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 4. module grants (who can reach the guarded analyser) ===';
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='user_module_access') INTO v_has;
  IF v_has THEN
    FOR r IN
      SELECT user_id, module::text AS module, (user_id = v_uid) AS is_owner
      FROM public.user_module_access
      ORDER BY 3 DESC, 2
    LOOP
      RAISE NOTICE 'user %  module %  owner=%', left(r.user_id::text, 8), rpad(r.module,28), r.is_owner;
    END LOOP;
  ELSE
    RAISE NOTICE 'no user_module_access table -- module grants live elsewhere';
    FOR r IN
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name ILIKE '%module%'
      ORDER BY 1
    LOOP RAISE NOTICE 'candidate table: %', r.table_name; END LOOP;
  END IF;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 5. analyser-shaped activity by user (eligibility cache rows) ===';
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='fba_eligibility_cache') INTO v_has;
  IF v_has THEN
    FOR r IN
      SELECT user_id, COUNT(*) AS lookups, MAX(updated_at)::date AS newest,
             (user_id = v_uid) AS is_owner
      FROM public.fba_eligibility_cache GROUP BY 1 ORDER BY 2 DESC
    LOOP
      RAISE NOTICE 'user %  lookups %  newest %  owner=%',
        left(r.user_id::text, 8), r.lookups, r.newest, r.is_owner;
    END LOOP;
  END IF;
END $p$;
