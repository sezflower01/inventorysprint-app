-- PROBE (read-only): the dedup change re-enabled THREE US assignments, not the
-- one that prompted it (670 -> 673 enabled, 787 -> 784 dedup-disabled).
--
-- Two of those were not asked for, so check they are legitimate FBA/FBM pairs
-- and not something the dedup was right to hold down.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== US assignments enabled in the last 30 minutes ========';
  FOR r IN
    SELECT a.asin, a.sku, COALESCE(rr.name,'(no rule)') AS rule_name, a.updated_at,
           i.source, i.listing_status, COALESCE(i.available,0) AS av,
           COALESCE(i.reserved,0) AS rv, COALESCE(i.inbound,0) AS ib,
           i.fnsku
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.marketplace = 'US' AND a.is_enabled
      AND a.updated_at > now() - interval '30 minutes'
    ORDER BY a.updated_at DESC LIMIT 15
  LOOP
    RAISE NOTICE '   % / %  rule=%', r.asin, rpad(r.sku,18), r.rule_name;
    RAISE NOTICE '        source=%  status=%  a/r/i=%/%/%  fnsku=%',
      rpad(COALESCE(r.source,'-'),18), COALESCE(r.listing_status,'-'),
      r.av, r.rv, r.ib, COALESCE(r.fnsku,'(none)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== every ASIN now holding 2+ ENABLED US assignments ========';
  -- After the change this should be FBA/FBM pairs only. Anything else here
  -- would mean the dedup stopped protecting against genuine duplicates.
  FOR r IN
    SELECT a.asin, count(*) AS enabled_skus,
           string_agg(a.sku || ' [' || COALESCE(i.source,'?') || ' av=' ||
                      COALESCE(i.available,0)::text || ']', '  |  ' ORDER BY a.sku) AS detail
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.marketplace = 'US' AND a.is_enabled
    GROUP BY a.asin HAVING count(*) > 1
    ORDER BY count(*) DESC LIMIT 12
  LOOP
    RAISE NOTICE '   %  (% enabled)', r.asin, r.enabled_skus;
    RAISE NOTICE '        %', left(r.detail, 180);
  END LOOP;
END
$probe$;
