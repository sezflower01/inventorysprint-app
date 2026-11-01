-- APPLY pass 1. dry_run FALSE -- this one writes.
--
-- Rules being honoured, and where each is enforced:
--
--  1. the 19 non-whole-number orders are excluded by the whole-number gate
--     INSIDE collapsed_order_candidates, so they are not in the shortlist this
--     reads and no argument passed here could reach them;
--  2. values come from GetOrderItems only, and the new ceiling gate skips and
--     records any row where Amazon reports MORE units than the money signal's
--     upper bound;
--  3. one invocation at a time, 2100ms pacing, nothing else calling Amazon;
--  4. reporting happens after the last pass, from the database rather than
--     from the responses -- which is the fix for yesterday's lost preview;
--  5. the before-picture is in collapsed_preapply_snapshot and
--     collapsed_repair_backup holds every row in full.
--
-- WHY NO OFFSET THIS TIME. A real apply records a verdict for every row it
-- settles, and collapsed_order_candidates excludes recorded rows, so the
-- shortlist SHRINKS as the work proceeds. Paging with an offset would skip the
-- head of a list that has already moved. Each pass therefore takes offset 0 and
-- the list walks itself down. Throttled rows are deliberately NOT recorded, so
-- they stay eligible and come back on a later pass -- which is also why rule 3
-- says stop and resume rather than retry hard.
--
-- limit 45 at 2100ms is ~95s, inside the 110s budget with room to finish
-- cleanly instead of being cut off mid-write.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_n
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);
  RAISE NOTICE '== candidates remaining before this pass: % ==', v_n;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='collapsed_repair_backup') THEN
    RAISE NOTICE '>>> NO BACKUP TABLE. Refusing to write.';
    RETURN;
  END IF;
  SELECT count(*) INTO v_n FROM public.collapsed_repair_backup;
  RAISE NOTICE '   backup on file: % rows', v_n;
  IF v_n < 285 THEN
    RAISE NOTICE '>>> backup holds only % rows, expected 285. Refusing to write.', v_n;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='collapsed_preapply_snapshot') THEN
    RAISE NOTICE '>>> NO BEFORE-SNAPSHOT. Rule 5 could not be tested. Refusing.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN
    RAISE NOTICE '>>> no INTERNAL_SYNC_SECRET. Not firing.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
                               'marketplace', NULL,
                               'limit', 45,
                               'offset', 0,
                               'dry_run', false),
    timeout_milliseconds := 118000
  ) INTO v_req;

  RAISE NOTICE '';
  RAISE NOTICE '   APPLY pass 1 fired at % -- request %', clock_timestamp(), v_req;
  RAISE NOTICE '   dry_run: false. This pass WRITES, but only values';
  RAISE NOTICE '   GetOrderItems confirms and only within the money ceiling.';
END
$p$;
