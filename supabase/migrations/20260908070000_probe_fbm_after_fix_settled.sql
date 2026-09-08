-- AFTER snapshot, second read.
--
-- fbm-quick-check returned {"checked":34,"found_stock":1,"retyped":1,
-- "activated":2} -- so it saw exactly the 34 candidates the sizing probe
-- predicted (33 lane A + 1 lane B), Amazon confirmed the lane B row as
-- merchant-fulfilled, and it was retyped. The first after-probe ran five
-- seconds later and still showed source='live_api', which is worth resolving
-- rather than shrugging at: inventory-refresh-worker-1m runs every minute and
-- could be stomping source back.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'settled read at %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== B0G2YNN87D : inventory ========';
  FOR r IN
    SELECT sku, source, listing_status, fnsku, COALESCE(available,0) AS av,
           COALESCE(reserved,0) AS rv, COALESCE(inbound,0) AS ib,
           updated_at, last_inventory_sync_at
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B0G2YNN87D'
    ORDER BY created_at
  LOOP
    RAISE NOTICE '   %  source=%  fnsku=%',
      rpad(r.sku,16), rpad(r.source,18), COALESCE(r.fnsku,'(cleared)');
    RAISE NOTICE '        status=%  available=%  reserved=%  inbound=%',
      r.listing_status, r.av, r.rv, r.ib;
    RAISE NOTICE '        updated=%  amazon_confirmed=%', r.updated_at, r.last_inventory_sync_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== B0G2YNN87D : US assignments ========';
  FOR r IN
    SELECT a.sku, a.is_enabled, COALESCE(rr.name,'(no rule)') AS rule_name,
           COALESCE(a.last_disabled_by,'-') AS dis_by,
           COALESCE(a.last_disabled_reason,'-') AS reason, a.updated_at
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE a.user_id = v_uid AND a.asin = 'B0G2YNN87D' AND a.marketplace = 'US'
    ORDER BY a.created_at
  LOOP
    RAISE NOTICE '   %  enabled=%  rule=%',
      rpad(r.sku,16), r.is_enabled, r.rule_name;
    RAISE NOTICE '        updated=%  disabled_by=%  reason=%',
      r.updated_at, r.dis_by, left(r.reason,50);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== would the row now show in the grid? ========';
  FOR r IN
    SELECT count(*) AS visible
    FROM public.repricer_assignments a
    JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.asin = 'B0G2YNN87D' AND a.marketplace = 'US'
      AND a.is_enabled
      AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
      AND COALESCE(i.available,0) > 0
  LOOP
    RAISE NOTICE '   % of the 2 SKUs pass the grid filter (enabled + ACTIVE + stock)', r.visible;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== account-wide (was: 1874 total / 670 enabled / 787 dedup-disabled) ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_enabled) AS enabled,
           count(*) FILTER (WHERE last_disabled_reason = 'auto-assign-bulk: broken/deleted assignment') AS dedup_disabled
    FROM public.repricer_assignments WHERE user_id = v_uid AND marketplace = 'US'
  LOOP
    RAISE NOTICE '   US assignments: % total | % enabled | % dedup-disabled',
      r.total, r.enabled, r.dedup_disabled;
  END LOOP;
END
$probe$;
