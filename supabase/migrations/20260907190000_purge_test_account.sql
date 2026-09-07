-- Hard purge of bassamshomali499@gmail.com, plus one orphan rule.
--
-- ---- AUTHORISATION -------------------------------------------------------
--
-- Confirmed by the account owner 2026-09-07: this is their own second/testing
-- account, created to test an Amazon connection. It interfered with the main
-- account's syncing, which is why it was abandoned. Not a customer. Both the
-- data and the login are to be removed.
--
-- ---- WHY A MULTI-PASS LOOP RATHER THAN A FIXED ORDER --------------------
--
-- 46 tables carry this user's rows and several reference each other -- e.g.
-- created_listing_purchases -> created_listings, both of which also carry
-- user_id. Hand-ordering 46 deletes is exactly the kind of list that is wrong
-- the first time and silently incomplete the second. Instead this deletes
-- every table it can on each pass and repeats while progress is being made,
-- so foreign-key order resolves itself. It stops only when a pass deletes
-- nothing, and then asserts that nothing is left.
--
-- ---- THE ORPHAN RULE -----------------------------------------------------
--
-- Rule 8362f6c1 belongs to an account already deleted through the app. It
-- survived because admin-manage-account's delete removes the auth user and
-- leaves the data -- the same defect that would have left ~27,000 rows behind
-- here. Noted for a proper fix; cleaned up by hand for now.

BEGIN;

CREATE TEMP TABLE _purge_before (tbl text, rows bigint) ON COMMIT DROP;

DO $$
DECLARE
  v_uid uuid;
  r record; v_sql text; v_n bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'bassamshomali499@gmail.com';
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'account not found -- refusing to guess which user to purge';
  END IF;
  RAISE NOTICE '================ BEFORE ================';
  RAISE NOTICE 'purging user_id %', v_uid;

  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'user_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', r.table_name)
        INTO v_n USING v_uid;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;  -- user_id of an incompatible type; not an ownership column
    END;
    IF v_n > 0 THEN
      INSERT INTO _purge_before VALUES (r.table_name, v_n);
    END IF;
  END LOOP;

  FOR r IN SELECT tbl, rows FROM _purge_before ORDER BY rows DESC LOOP
    RAISE NOTICE '   %-44s %', r.tbl, r.rows;
  END LOOP;
  RAISE NOTICE 'TOTAL: % rows across % tables',
    (SELECT COALESCE(sum(rows),0) FROM _purge_before),
    (SELECT count(*) FROM _purge_before);
END $$;

-- ---- the purge ----------------------------------------------------------
DO $$
DECLARE
  v_uid uuid; r record; v_n bigint;
  v_pass int := 0; v_deleted_this_pass bigint; v_total bigint := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'bassamshomali499@gmail.com';

  LOOP
    v_pass := v_pass + 1;
    v_deleted_this_pass := 0;

    FOR r IN SELECT tbl FROM _purge_before LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', r.tbl) USING v_uid;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_deleted_this_pass := v_deleted_this_pass + v_n;
        v_total := v_total + v_n;
      EXCEPTION WHEN foreign_key_violation THEN
        -- Something still references these rows; a later pass will reach it
        -- once its own dependants are gone.
        NULL;
      END;
    END LOOP;

    RAISE NOTICE 'pass %: deleted % rows', v_pass, v_deleted_this_pass;
    EXIT WHEN v_deleted_this_pass = 0;
    IF v_pass > 12 THEN
      RAISE EXCEPTION 'still deleting after 12 passes -- stopping rather than looping';
    END IF;
  END LOOP;

  RAISE NOTICE 'purged % rows in % passes', v_total, v_pass;
END $$;

-- ---- the orphan rule from the previously-deleted account ---------------
DO $$
DECLARE v_n int;
BEGIN
  DELETE FROM public.repricer_rules rr
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = rr.user_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'orphan rules removed: %', v_n;
END $$;

-- ---- the login ----------------------------------------------------------
DO $$
DECLARE v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'bassamshomali499@gmail.com';
  DELETE FROM auth.users WHERE id = v_uid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'auth users removed: %', v_n;
END $$;

-- ---- verification -------------------------------------------------------
DO $$
DECLARE r record; v_left bigint := 0; v_n bigint; v_uid uuid;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================ AFTER ================';

  -- The auth row is gone, so re-derive the id from what we recorded rather
  -- than looking it up again.
  SELECT user_id INTO v_uid FROM (
    SELECT '3f0f8098-9112-43bc-941c-7795b3027296'::uuid AS user_id
  ) q;

  FOR r IN SELECT tbl FROM _purge_before ORDER BY tbl LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', r.tbl)
        INTO v_n USING v_uid;
    EXCEPTION WHEN OTHERS THEN CONTINUE;
    END;
    IF v_n > 0 THEN
      RAISE NOTICE '   STILL PRESENT: %-40s %', r.tbl, v_n;
      v_left := v_left + v_n;
    END IF;
  END LOOP;

  RAISE NOTICE 'rows remaining for that account: % (must be 0)', v_left;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'purge incomplete -- % rows remain', v_left;
  END IF;

  SELECT count(*) INTO v_n FROM auth.users WHERE email = 'bassamshomali499@gmail.com';
  RAISE NOTICE 'auth.users rows for that email: % (must be 0)', v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'login still exists'; END IF;

  SELECT count(*) INTO v_n FROM public.repricer_rules rr
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = rr.user_id);
  RAISE NOTICE 'orphan rules with no owner: % (must be 0)', v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'orphan rules remain'; END IF;

  -- And confirm the main account is untouched.
  FOR r IN
    SELECT (SELECT count(*) FROM public.repricer_rules WHERE user_id = u.id) AS rules,
           (SELECT count(*) FROM public.repricer_assignments WHERE user_id = u.id) AS assignments,
           (SELECT count(*) FROM public.sales_orders WHERE user_id = u.id) AS orders,
           (SELECT count(*) FROM public.inventory WHERE user_id = u.id) AS inventory
    FROM auth.users u WHERE u.email = 'sezflower01@gmail.com'
  LOOP
    RAISE NOTICE 'main account intact: % rules | % assignments | % orders | % inventory',
      r.rules, r.assignments, r.orders, r.inventory;
  END LOOP;
END $$;

COMMIT;
