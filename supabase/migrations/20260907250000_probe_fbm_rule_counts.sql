-- PROBE (read-only): the badge says 18 ASINs, the seller counts 8.
--
-- The badge renders distinct_asins from get_rule_assignment_counts(), which
-- counts EVERY assignment on the rule regardless of whether it is enabled or
-- whether the listing is live. The Repricer table shows one marketplace at a
-- time and hides ghosts and zero-stock rows. So the two numbers are answering
-- different questions and neither is wrong -- but the badge is the one that
-- looks authoritative and it is the less useful of the two.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== FBM Competes with all -- every layer ========';
  FOR r IN
    SELECT count(*) AS assignments,
           count(DISTINCT a.asin) AS distinct_asins,
           count(*) FILTER (WHERE a.is_enabled) AS enabled,
           count(DISTINCT a.asin) FILTER (WHERE a.is_enabled) AS enabled_asins,
           count(DISTINCT a.asin) FILTER (
             WHERE a.is_enabled
               AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
               AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                  +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0) AS live_asins
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND rr.name = 'FBM Competes with all'
  LOOP
    RAISE NOTICE '   % assignments | % distinct ASINs  <- the badge shows this',
      r.assignments, r.distinct_asins;
    RAISE NOTICE '   % enabled      | % enabled ASINs', r.enabled, r.enabled_asins;
    RAISE NOTICE '   % LIVE ASINs (enabled + ACTIVE + in stock)', r.live_asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== by marketplace -- the table shows ONE at a time ========';
  FOR r IN
    SELECT a.marketplace,
           count(*) AS assignments,
           count(*) FILTER (WHERE a.is_enabled) AS enabled,
           count(*) FILTER (
             WHERE a.is_enabled
               AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
               AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                  +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0) AS live
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND rr.name = 'FBM Competes with all'
    GROUP BY a.marketplace ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   % : % assignments | % enabled | % live', r.marketplace, r.assignments, r.enabled, r.live;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the rows themselves ========';
  FOR r IN
    SELECT a.marketplace, a.asin, left(a.sku,20) AS sku, a.is_enabled,
           COALESCE(i.listing_status,'(no inv row)') AS status,
           COALESCE(i.available,0) AS avail,
           COALESCE(i.unfulfilled,0) AS unf
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND rr.name = 'FBM Competes with all'
    ORDER BY a.marketplace, a.asin
  LOOP
    RAISE NOTICE '   % | % | % | enabled=% | % | avail=% unf=%',
      r.marketplace, r.asin, r.sku, r.is_enabled, r.status, r.avail, r.unf;
  END LOOP;
END
$probe$;
