-- Did anyone actually use the operator's Amazon account? READ ONLY.
--
-- The guard (20261112, _shared/operator-credential-guard.ts) closes the door.
-- This asks whether anyone walked through it first. Edge-function logs are not
-- queryable from SQL and the dashboard keeps them for days, not the months the
-- fallback existed, so logs cannot answer this for the whole period. The DURABLE
-- evidence is the rows those functions wrote, and that is what this reads.
--
-- Four questions:
--   1. The operator's user id (for SPAPI_OWNER_USER_ID) and seller ids.
--   2. fba_eligibility_cache / fba_readiness_cache -- any row belonging to a
--      NON-owner but stamped with the OPERATOR's seller_id? That is a gating
--      verdict computed from the operator's brand approvals and cached as if it
--      were the user's own. check-fba-listing-eligibility keys its cache on
--      (user_id, seller_id, marketplace_id, asin), so the pair is visible.
--   3. created_listings / listing_validations / listing_validation_audit --
--      any row owned by a non-owner? create-amazon-listing WRITES to Amazon on
--      the operator's account in its fallback branch, then updates
--      created_listings, so a non-owner row is the trace of a listing created
--      in the operator's Seller Central.
--   4. inventory / ghost_sku_quarantine -- any non-owner row? bulk-live-verify
--      uses the operator's token UNCONDITIONALLY and writes under whatever
--      user_id it was given, so a non-owner row there means the operator's
--      Amazon catalog state was written into someone else's inventory.

DO $p$
DECLARE
  v_owner uuid;
  r record;
  v_sql text; n bigint;
  v_seller_ids text[];
BEGIN
  SELECT id INTO v_owner FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '=== 1. OPERATOR IDENTITY ===';
  RAISE NOTICE 'SPAPI_OWNER_USER_ID = %', v_owner;

  SELECT array_agg(DISTINCT seller_id) INTO v_seller_ids
  FROM public.seller_authorizations WHERE user_id = v_owner AND seller_id IS NOT NULL;
  RAISE NOTICE 'operator seller_id(s): %', COALESCE(array_to_string(v_seller_ids, ', '), '(none)');

  FOR r IN
    SELECT marketplace_id, seller_id, is_active
    FROM public.seller_authorizations WHERE user_id = v_owner ORDER BY marketplace_id
  LOOP
    RAISE NOTICE '  marketplace % seller % active=%', r.marketplace_id, r.seller_id, r.is_active;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 2. BORROWED GATING: non-owner rows stamped with the operator seller_id ===';
  FOR r IN
    SELECT unnest(ARRAY['fba_eligibility_cache','fba_readiness_cache','fba_readiness_audit']) AS t
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name=r.t) THEN
      RAISE NOTICE '% : table absent', r.t; CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=r.t AND column_name='seller_id') THEN
      -- no seller_id column: just report non-owner rows
      v_sql := format('SELECT COUNT(*) FROM public.%I WHERE user_id <> %L', r.t, v_owner);
      EXECUTE v_sql INTO n;
      RAISE NOTICE '% : no seller_id column; non-owner rows = %', rpad(r.t,24), n;
      CONTINUE;
    END IF;
    v_sql := format(
      'SELECT COUNT(*) FROM public.%I WHERE user_id <> %L AND seller_id = ANY(%L)',
      r.t, v_owner, v_seller_ids);
    EXECUTE v_sql INTO n;
    RAISE NOTICE '% : BORROWED rows = %', rpad(r.t,24), n;
    v_sql := format('SELECT COUNT(*) FROM public.%I WHERE user_id <> %L', r.t, v_owner);
    EXECUTE v_sql INTO n;
    RAISE NOTICE '% : non-owner rows (any seller_id) = %', rpad(r.t,24), n;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 3 & 4. NON-OWNER ROWS in every table these functions write ===';
  FOR r IN
    SELECT unnest(ARRAY[
      'created_listings','listing_validations','listing_validation_audit',
      'listing_validation_queue','inventory','ghost_sku_quarantine','fnsku_map',
      'user_approved_products','repricer_assignments','asin_dimensions_cache',
      'user_analyser_readings'
    ]) AS t
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name=r.t) THEN
      RAISE NOTICE '% : table absent', rpad(r.t,26); CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=r.t AND column_name='user_id') THEN
      RAISE NOTICE '% : no user_id column, not user-scoped', rpad(r.t,26); CONTINUE;
    END IF;
    v_sql := format('SELECT COUNT(*) FROM public.%I WHERE user_id <> %L', r.t, v_owner);
    EXECUTE v_sql INTO n;
    IF n > 0 THEN
      RAISE NOTICE '*** % : % NON-OWNER ROW(S) -- inspect', rpad(r.t,26), n;
    ELSE
      RAISE NOTICE '% : 0 non-owner rows', rpad(r.t,26);
    END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 5. who else exists, and has any of them any SP-API? ===';
  FOR r IN
    SELECT u.id, (u.id = v_owner) AS is_owner,
           EXISTS (SELECT 1 FROM public.seller_authorizations sa
                   WHERE sa.user_id = u.id AND sa.is_active) AS has_spapi,
           u.last_sign_in_at::date AS last_seen
    FROM auth.users u ORDER BY u.created_at
  LOOP
    RAISE NOTICE 'user %  owner=%  has_spapi=%  last_sign_in=%',
      left(r.id::text,8), r.is_owner, r.has_spapi, COALESCE(r.last_seen::text,'never');
  END LOOP;
END $p$;
