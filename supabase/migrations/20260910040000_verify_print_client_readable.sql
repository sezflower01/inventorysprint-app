-- VERIFY the print-client download actually works now, rather than assuming the
-- policy is enough.
--
-- createSignedUrl enforces RLS on storage.objects as the `authenticated` role,
-- so the honest test is to become that role, carry a real JWT claim set, and
-- try the read. Anything less is reading the policy text back to myself.
--
-- Runs as a transaction-local role switch; SET LOCAL reverts on commit.

DO $verify$
DECLARE
  v_uid uuid;
  v_visible int;
  v_others int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'testing as user %', v_uid;

  -- Impersonate an ordinary signed-in session.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO v_visible
  FROM storage.objects
  WHERE bucket_id = 'access' AND name = 'SprintPrint.exe';

  -- The point of the narrow policy: nothing ELSE at the bucket root should have
  -- become readable. credentials.json lives there.
  SELECT count(*) INTO v_others
  FROM storage.objects
  WHERE bucket_id = 'access' AND name <> 'SprintPrint.exe';

  PERFORM set_config('role', 'postgres', true);

  RAISE NOTICE '';
  RAISE NOTICE '======== as an ordinary signed-in user ========';
  RAISE NOTICE '   SprintPrint.exe visible : %  (needs to be 1)', v_visible;
  RAISE NOTICE '   other access objects    : %  (needs to be 0)', v_others;

  IF v_visible = 1 AND v_others = 0 THEN
    RAISE NOTICE '   -> PASS: the download is unblocked and nothing else leaked';
  ELSIF v_visible = 0 THEN
    RAISE NOTICE '   -> FAIL: still refused, the button will still say object not found';
  ELSE
    RAISE NOTICE '   -> PROBLEM: % other objects became readable', v_others;
  END IF;
END
$verify$;
