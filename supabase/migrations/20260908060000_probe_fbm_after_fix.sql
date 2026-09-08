-- AFTER snapshot: read the fbm-quick-check response and the resulting state.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'AFTER snapshot at %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== what fbm-quick-check returned ========';
  FOR r IN
    SELECT status_code, left(content::text, 300) AS body, created
    FROM net._http_response WHERE id = 36619
  LOOP
    RAISE NOTICE '   % | % | %', r.created, r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== B0G2YNN87D : inventory ========';
  FOR r IN
    SELECT sku, source, listing_status, fnsku, COALESCE(available,0) AS av,
           COALESCE(reserved,0) AS rv, COALESCE(inbound,0) AS ib, updated_at
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B0G2YNN87D'
    ORDER BY created_at
  LOOP
    RAISE NOTICE '   %  source=%  fnsku=%',
      rpad(r.sku,16), rpad(r.source,18), COALESCE(r.fnsku,'(cleared)');
    RAISE NOTICE '        status=%  a/r/i=%/%/%  updated=%',
      r.listing_status, r.av, r.rv, r.ib, r.updated_at;
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
    RAISE NOTICE '   %  enabled=%  rule=%  updated=%',
      rpad(r.sku,16), r.is_enabled, rpad(r.rule_name,24), r.updated_at;
    RAISE NOTICE '        disabled_by=%  reason=%', r.dis_by, left(r.reason,55);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== account-wide totals (was: 1874 / 670 / 787) ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_enabled) AS enabled,
           count(*) FILTER (WHERE last_disabled_reason = 'auto-assign-bulk: broken/deleted assignment') AS dedup_disabled
    FROM public.repricer_assignments WHERE user_id = v_uid AND marketplace = 'US'
  LOOP
    RAISE NOTICE '   US assignments: % total | % enabled | % disabled by the dedup',
      r.total, r.enabled, r.dedup_disabled;
  END LOOP;
END
$probe$;
