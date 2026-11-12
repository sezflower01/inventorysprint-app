-- The decisive fact: can a non-owner user reach the analyser TODAY? READ ONLY.
--
-- fetch-listing-snapshot gates on checkModuleAccess(user, 'personalhour',
-- 'view') -- so the analyser's module key is `personalhour`, and the previous
-- probe showed user e790054c already holds `personalhour` grants.
--
-- It also showed each module three times per user, which looked like duplicate
-- rows. Almost certainly it is one row per ACTION (view/edit/delete) and the
-- probe simply did not select the action column -- so print it, rather than
-- report a hygiene bug that is not there. Then ask the guard's own RPC the
-- actual question, instead of inferring the answer from the rows.

DO $p$
DECLARE r record; v_owner uuid; v_ans boolean;
BEGIN
  SELECT id INTO v_owner FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '=== module grants WITH the action column ===';
  FOR r IN
    SELECT user_id, module::text AS m, action::text AS a
    FROM public.user_module_access
    ORDER BY 1, 2, 3
  LOOP
    RAISE NOTICE 'user %  %  %', left(r.user_id::text,8), rpad(r.m,22), r.a;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== has_module_access(user, personalhour, view) -- the guard''s own answer ===';
  FOR r IN SELECT id, (id = v_owner) AS is_owner FROM auth.users ORDER BY created_at LOOP
    SELECT public.has_module_access(r.id, 'personalhour', 'view') INTO v_ans;
    RAISE NOTICE 'user %  owner=%  CAN RUN ANALYSER: %',
      left(r.id::text,8), r.is_owner, COALESCE(v_ans::text,'null');
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== duplicate check: same (user, module, action) more than once? ===';
  FOR r IN
    SELECT user_id, module::text AS m, action::text AS a, COUNT(*) AS n
    FROM public.user_module_access
    GROUP BY 1,2,3 HAVING COUNT(*) > 1
  LOOP
    RAISE NOTICE 'DUPLICATE user % % % x%', left(r.user_id::text,8), r.m, r.a, r.n;
  END LOOP;
  RAISE NOTICE '(no DUPLICATE lines = the triples were one row per action, not duplicates)';
END $p$;
