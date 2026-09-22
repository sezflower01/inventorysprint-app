-- READ-ONLY PROBE. Did the queued inventory refresh for B09N1RG7JC run, what
-- listing_status did Amazon report, and has the repricer dispatched it since?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT status, attempts, last_error, to_char(created_at, 'HH24:MI:SS') AS queued, to_char(processed_at, 'HH24:MI:SS') AS processed
           FROM public.inventory_refresh_queue
           WHERE user_id = v_uid AND asin = 'B09N1RG7JC' AND sku = '1067509411'
           ORDER BY created_at DESC LIMIT 2 LOOP
    RAISE NOTICE 'refresh queue: % (attempts %) queued % processed % | error %', r.status, r.attempts, r.queued, COALESCE(r.processed,'-'), COALESCE(r.last_error,'-');
  END LOOP;

  FOR r IN SELECT listing_status, available, to_char(last_inventory_sync_at, 'HH24:MI:SS') AS synced, to_char(updated_at, 'HH24:MI:SS') AS upd
           FROM public.inventory WHERE user_id = v_uid AND sku = '1067509411' LOOP
    RAISE NOTICE 'inventory: status % | available % | synced % | updated %', r.listing_status, r.available, r.synced, r.upd;
  END LOOP;

  FOR r IN SELECT is_listing_inactive_not_buyable AS inactive, to_char(last_dispatch_at, 'HH24:MI:SS') AS dispatched,
                  to_char(last_evaluated_at, 'HH24:MI:SS') AS evaluated, last_applied_price, last_buybox_status
           FROM public.repricer_assignments WHERE user_id = v_uid AND asin = 'B09N1RG7JC' AND marketplace = 'US' LOOP
    RAISE NOTICE 'repricer: not-buyable % | last dispatch % | last eval % | price % | BB %', r.inactive, r.dispatched, r.evaluated, r.last_applied_price, r.last_buybox_status;
  END LOOP;
END
$p$;
