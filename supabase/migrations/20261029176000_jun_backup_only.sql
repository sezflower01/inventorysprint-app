-- JUNE, step 1 of 2: take the backup and COMMIT it.
--
-- Split from the diff deliberately. On May the first attempt did both in one
-- transaction and the diff reported all 3,792 rows as "new" -- it could not see
-- the uncommitted backup. Separate migrations remove the question entirely.
DO $p$
DECLARE v_uid uuid; v_live int; v_backed bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-06-01' AND event_date < '2026-07-01';
  IF v_live <> 5682 THEN
    RAISE EXCEPTION 'June live rows %, expected 5682 -- the month moved since the gate', v_live;
  END IF;

  v_backed := public.fec_backup_month(v_uid, '2026-06-01'::date);
  RAISE NOTICE 'June: live % rows | backed up %', v_live, v_backed;
  IF v_backed <> v_live THEN
    RAISE EXCEPTION 'backup % vs live % -- refusing to go further', v_backed, v_live;
  END IF;
  RAISE NOTICE '   backup count verified -- fec_restore_month can undo from here';
END
$p$;
