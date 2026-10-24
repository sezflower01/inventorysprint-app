-- ITEM 4. ONE July dry run. Nothing is applied: apply := false.
--
-- Why not the browser, which was the asked-for path: the preview pane has no
-- signed-in session, and signing in on the user's behalf is not something I
-- will do. A direct HTTPS call from the shell also fails -- the function's
-- guard compares the bearer against SUPABASE_SERVICE_ROLE_KEY, which this
-- project now injects as the NEW sb_secret_ key, and the CLI masks that value.
--
-- So this fires through pg_net with the Vault secret. That is safe now in a way
-- it was not when July first failed: the function calls persistReport() on
-- every exit path, so the result lands in repull_reports whether or not pg_net
-- keeps the response. A dropped response can no longer lose the run -- which is
-- exactly the reason persistReport was added.
--
-- ONE call. No loop, no driver, no second month.
DO $p$
DECLARE
  v_uid uuid;
  v_req bigint;
  v_prior int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  IF v_uid IS NULL THEN RAISE EXCEPTION 'user not found'; END IF;

  SELECT count(*) INTO v_prior FROM public.repull_reports WHERE left(month,7) = '2026-07';
  RAISE NOTICE 'July reports already on file before this run: %', v_prior;

  -- Refuse to fire if a July run is already in flight, so "one invocation"
  -- stays true even if an earlier attempt is still running somewhere.
  IF EXISTS (
    SELECT 1 FROM net.http_request_queue q
    WHERE q.url LIKE '%repull-month-adjustments%'
  ) THEN
    RAISE EXCEPTION 'a repull call is still queued in pg_net -- not firing a second one';
  END IF;

  v_req := public.repull_fire(v_uid, '2026-07-01'::date, false);
  RAISE NOTICE 'fired ONE July dry run, pg_net request id %', v_req;
  RAISE NOTICE 'read the result with: SELECT public.repull_find_report(''2026-07-01'', false)';
END
$p$;
