-- BEFORE snapshot, taken immediately prior to deploying the two fixes:
--   1. auto-assign-bulk dedup keyed on (asin, channel) rather than asin
--   2. fbm-quick-check gains a second candidate lane for source='live_api'
--
-- Recorded so the after-state can be compared to something written down rather
-- than remembered.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'BEFORE snapshot at %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== B0G2YNN87D : inventory ========';
  FOR r IN
    SELECT sku, source, listing_status, COALESCE(available,0) AS av,
           COALESCE(reserved,0) AS rv, COALESCE(inbound,0) AS ib, updated_at
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B0G2YNN87D'
    ORDER BY created_at
  LOOP
    RAISE NOTICE '   %  source=%  status=%  a/r/i=%/%/%  updated=%',
      rpad(r.sku,16), rpad(r.source,16), r.listing_status, r.av, r.rv, r.ib, r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== B0G2YNN87D : US assignments ========';
  FOR r IN
    SELECT a.sku, a.is_enabled, COALESCE(rr.name,'(no rule)') AS rule_name,
           COALESCE(a.last_disabled_by,'-') AS dis_by,
           COALESCE(a.last_disabled_reason,'-') AS reason
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE a.user_id = v_uid AND a.asin = 'B0G2YNN87D' AND a.marketplace = 'US'
    ORDER BY a.created_at
  LOOP
    RAISE NOTICE '   %  enabled=%  rule=%', rpad(r.sku,16), r.is_enabled, r.rule_name;
    RAISE NOTICE '        disabled_by=%  reason=%', r.dis_by, left(r.reason,60);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== account-wide totals ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_enabled) AS enabled,
           count(*) FILTER (WHERE last_disabled_reason = 'auto-assign-bulk: broken/deleted assignment') AS dedup_disabled
    FROM public.repricer_assignments WHERE user_id = v_uid AND marketplace = 'US'
  LOOP
    RAISE NOTICE '   US assignments: % total | % enabled | % disabled by the dedup',
      r.total, r.enabled, r.dedup_disabled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many ASINs would the new dedup key spare? ========';
  -- Pairs on one ASIN that the OLD key collapses and the NEW key keeps: one
  -- FBA-looking SKU and one FBM-looking SKU, both currently ACTIVE.
  FOR r IN
    WITH tagged AS (
      SELECT i.asin, i.sku,
             (COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) > 0
               OR (i.fnsku IS NOT NULL AND NOT (i.source = 'amazon_sync_fbm'
                                                AND COALESCE(i.reserved,0) + COALESCE(i.inbound,0) = 0))
             AS looks_fba
      FROM public.inventory i
      WHERE i.user_id = v_uid AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
    )
    SELECT asin,
           count(*) FILTER (WHERE looks_fba) AS fba_skus,
           count(*) FILTER (WHERE NOT looks_fba) AS fbm_skus
    FROM tagged GROUP BY asin
    HAVING count(*) FILTER (WHERE looks_fba) > 0 AND count(*) FILTER (WHERE NOT looks_fba) > 0
  LOOP
    RAISE NOTICE '   %  : % FBA SKU(s) + % FBM SKU(s)', r.asin, r.fba_skus, r.fbm_skus;
  END LOOP;
END
$probe$;
