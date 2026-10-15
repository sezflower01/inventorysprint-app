-- Fix: the recheck audit table had RLS on and only a SELECT policy, so every
-- INSERT was denied and the button failed with a non-2xx on first use.
--
-- The function writes the backup as the CALLING USER (user-scoped client, no
-- service-role key anywhere in that path), so it needs an INSERT policy of
-- its own. Enabling RLS and writing only a SELECT policy is a silent deny:
-- nothing in the migration complains, and the failure only appears when a
-- real press hits it.
--
-- Shape of the failure, for next time: keepa-recheck-nonus-estimate aborts
-- deliberately when the backup insert fails ("Backup failed, nothing was
-- changed", HTTP 500) rather than proceeding, so no sales_orders row was
-- touched. The guard worked; the policy was wrong.
--
-- INSERT and SELECT only, deliberately. This is an audit trail: rows are
-- appended and read, never edited or removed, so no UPDATE or DELETE policy
-- is granted. A user cannot rewrite the record of what their own override
-- replaced. (Confirmed by accident on the first attempt at this migration --
-- the self-test tried to DELETE its own row as `authenticated` and was
-- refused, which is the intended posture.)

DROP POLICY IF EXISTS "own recheck log insert" ON public.keepa_estimate_recheck_log;
CREATE POLICY "own recheck log insert" ON public.keepa_estimate_recheck_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Prove it works for the real user, as the authenticated role. The test runs
-- in a nested block that is deliberately rolled back, so no row is ever left
-- behind and no DELETE is needed -- RAISE NOTICE output survives the
-- rollback, the INSERT does not. An untested RLS fix is how this bug reached
-- a live button in the first place.
DO $p$
DECLARE v_uid uuid; v_inserted int := 0; v_readable boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
                       true);

    INSERT INTO public.keepa_estimate_recheck_log
      (user_id, order_id, asin, marketplace, old_estimate, new_estimate, keepa_track)
    VALUES (v_uid, 'RLS-SELF-TEST', 'TESTASIN00', 'CA', 1.00, 2.00, 'buybox');
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    SELECT EXISTS (SELECT 1 FROM public.keepa_estimate_recheck_log
                   WHERE order_id = 'RLS-SELF-TEST') INTO v_readable;

    RAISE NOTICE '== RLS INSERT as the authenticated user: % row -> %',
      v_inserted, CASE WHEN v_inserted = 1 THEN 'PASS' ELSE 'FAIL' END;
    RAISE NOTICE '== RLS SELECT back by its owner: %',
      CASE WHEN v_readable THEN 'PASS' ELSE 'FAIL' END;

    -- Unwind the whole probe, row included.
    RAISE EXCEPTION 'rls_selftest_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rls_selftest_rollback' THEN
      RAISE NOTICE '== RLS SELF-TEST ERROR: % ==', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '== self-test rolled back; no test row persisted ==';
END
$p$;

-- Independent confirmation that nothing was left behind, and that the table
-- now carries both policies it needs.
DO $p$
DECLARE n_rows int; n_ins int; n_sel int;
BEGIN
  SELECT count(*) INTO n_rows FROM public.keepa_estimate_recheck_log;
  SELECT count(*) INTO n_ins FROM pg_policy
    WHERE polrelid = 'public.keepa_estimate_recheck_log'::regclass AND polcmd::text IN ('a','*');
  SELECT count(*) INTO n_sel FROM pg_policy
    WHERE polrelid = 'public.keepa_estimate_recheck_log'::regclass AND polcmd::text IN ('r','*');
  RAISE NOTICE '== table rows: % (want 0) | INSERT policies: % (want >=1) | SELECT policies: % (want >=1) ==',
    n_rows, n_ins, n_sel;
END
$p$;
