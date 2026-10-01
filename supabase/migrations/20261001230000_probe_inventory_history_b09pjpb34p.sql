-- READ-ONLY PROBE. The revive wrote ACTIVE with source=force_relist twice and
-- the row still reads NOT_IN_CATALOG with source=live_api, so a third party is
-- re-ghosting it within seconds. inventory_history is written by
-- fn_capture_inventory_history on every UPDATE, so the sequence is recorded.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== last 25 history rows for this SKU ==';
  FOR r IN SELECT captured_at, listing_status, available, reserved, inbound, source, sync_trace_id
           FROM public.inventory_history
           WHERE user_id = v_uid AND asin = 'B09PJPB34P'
           ORDER BY captured_at DESC LIMIT 25 LOOP
    RAISE NOTICE '  % | % | % / % / % | source % | trace %',
      r.captured_at, r.listing_status, r.available, r.reserved, r.inbound, r.source, COALESCE(r.sync_trace_id::text, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is this SKU sitting in the inventory refresh queue? ==';
  FOR r IN SELECT status, priority, attempts, created_at, updated_at
           FROM public.inventory_refresh_queue
           WHERE user_id = v_uid AND asin = 'B09PJPB34P'
           ORDER BY created_at DESC LIMIT 10 LOOP
    RAISE NOTICE '  % | priority % | attempts % | created % | updated %',
      r.status, r.priority, r.attempts, r.created_at, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (not queued)'; END IF;
END
$p$;
