-- Resolve a discrepancy in my own report. READ ONLY.
--
-- The step-2 verification printed B00LFXMBKI as ACTIVE, yet it did not appear
-- in the 14-row changed list, which compares the backup against live. Both
-- cannot be true unless the row is not in the backup -- i.e. it was never in
-- the target set. Checking rather than explaining it away.
DO $p$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_n FROM public.revive_target_20261101 WHERE asin='B00LFXMBKI';
  RAISE NOTICE 'B00LFXMBKI in the target set? % row(s)', v_n;
  SELECT count(*) INTO v_n FROM public.revive_backup_20261101 WHERE asin='B00LFXMBKI';
  RAISE NOTICE 'B00LFXMBKI in the backup?     % row(s)', v_n;

  RAISE NOTICE '';
  RAISE NOTICE 'live inventory rows for it:';
  FOR r IN
    SELECT i.id, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.listing_status,'-') AS st,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib, COALESCE(i.source,'-') AS src,
           i.last_inventory_sync_at AS synced, i.updated_at
    FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   id % | sku % | % | av % rv % ib % | src % | synced % | upd %',
      r.id, r.sku, r.st, r.av, r.rv, r.ib, r.src, r.synced, r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'backup rows for it:';
  FOR r IN
    SELECT b.id, COALESCE(b.sku,'(null)') AS sku,
           COALESCE(b.listing_status,'-') AS st,
           COALESCE(b.available,0) AS av, COALESCE(b.reserved,0) AS rv,
           COALESCE(b.inbound,0) AS ib
    FROM public.revive_backup_20261101 b WHERE b.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   id % | sku % | % | av % rv % ib %',
      r.id, r.sku, r.st, r.av, r.rv, r.ib;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE -- so it was never a target, and whatever made it';
    RAISE NOTICE '   ACTIVE was NOT this run. Most likely the scheduled';
    RAISE NOTICE '   worker/sync that drained 30 queue rows between the enqueue';
    RAISE NOTICE '   and my first pass, or an ordinary inventory sync.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'why might it have missed the target filter?';
  FOR r IN
    SELECT COALESCE(i.listing_status,'-') AS st,
           COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0) AS tot,
           (i.asin IS NULL) AS no_asin, (i.sku IS NULL) AS no_sku
    FROM public.inventory i WHERE i.user_id = v_uid AND i.asin='B00LFXMBKI'
  LOOP
    RAISE NOTICE '   now: status % | total stock % | null asin % | null sku %',
      r.st, r.tot, r.no_asin, r.no_sku;
    RAISE NOTICE '   target needed listing_status = INACTIVE at capture time.';
    RAISE NOTICE '   If it was already ACTIVE by then, it was correctly skipped.';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'READ ONLY.';
END
$p$;
