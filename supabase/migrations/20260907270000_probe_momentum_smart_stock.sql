-- PROBE (read-only): why does Momentum Smart read 156 when it holds 658 ASINs?
--
-- 156 is the new badge figure: enabled, ACTIVE, and AVAILABLE > 0. The number
-- did not fall -- the badge changed from counting every ASIN on the rule to
-- counting the ones the grid actually shows. But 156 of 640 enabled is a big
-- gap and worth explaining precisely rather than waving at.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== Momentum Smart, layer by layer ========';
  FOR r IN
    SELECT count(*) AS assignments,
           count(DISTINCT a.asin) AS total_asins,
           count(*) FILTER (WHERE a.is_enabled) AS enabled,
           count(DISTINCT a.asin) FILTER (WHERE a.is_enabled) AS enabled_asins,
           count(DISTINCT a.asin) FILTER (WHERE a.is_enabled
             AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE') AS enabled_active,
           count(DISTINCT a.asin) FILTER (WHERE a.is_enabled
             AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
             AND COALESCE(i.available,0) > 0) AS available_now
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND rr.name = 'Momentum Smart'
  LOOP
    RAISE NOTICE '   % assignments over % distinct ASINs', r.assignments, r.total_asins;
    RAISE NOTICE '   % enabled (% ASINs)', r.enabled, r.enabled_asins;
    RAISE NOTICE '   % enabled AND listing ACTIVE', r.enabled_active;
    RAISE NOTICE '   % enabled + ACTIVE + AVAILABLE > 0   <- the badge', r.available_now;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== where the enabled ASINs drop out ========';
  FOR r IN
    SELECT
      count(DISTINCT a.asin) FILTER (WHERE i.sku IS NULL) AS no_inventory_row,
      count(DISTINCT a.asin) FILTER (WHERE i.sku IS NOT NULL
        AND upper(COALESCE(i.listing_status,'')) <> 'ACTIVE') AS not_active,
      count(DISTINCT a.asin) FILTER (WHERE upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
        AND COALESCE(i.available,0) = 0
        AND COALESCE(i.reserved,0)+COALESCE(i.inbound,0) > 0) AS zero_avail_but_reserved_inbound,
      count(DISTINCT a.asin) FILTER (WHERE upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
        AND COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0) = 0) AS completely_empty
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND rr.name = 'Momentum Smart' AND a.is_enabled
  LOOP
    RAISE NOTICE '   % ASINs have no inventory row at all', r.no_inventory_row;
    RAISE NOTICE '   % ASINs have a row but listing is not ACTIVE', r.not_active;
    RAISE NOTICE '   % ASINs ACTIVE, 0 available, but reserved/inbound exists', r.zero_avail_but_reserved_inbound;
    RAISE NOTICE '   % ASINs ACTIVE with NO stock anywhere -- sold out', r.completely_empty;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== per marketplace ========';
  FOR r IN
    SELECT a.marketplace,
           count(*) AS assignments,
           count(*) FILTER (WHERE a.is_enabled) AS enabled,
           count(*) FILTER (WHERE a.is_enabled
             AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
             AND COALESCE(i.available,0) > 0) AS available_now
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND rr.name = 'Momentum Smart'
    GROUP BY a.marketplace ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   % : % assignments | % enabled | % with available stock',
      r.marketplace, r.assignments, r.enabled, r.available_now;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== sanity: how much of the whole catalogue has stock? ========';
  FOR r IN
    SELECT count(*) AS inventory_rows,
           count(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_available,
           count(*) FILTER (WHERE upper(COALESCE(listing_status,'')) = 'ACTIVE') AS active,
           count(*) FILTER (WHERE upper(COALESCE(listing_status,'')) = 'ACTIVE'
             AND COALESCE(available,0) > 0) AS active_and_available
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % inventory rows | % ACTIVE | % with available | % both',
      r.inventory_rows, r.active, r.with_available, r.active_and_available;
  END LOOP;
END
$probe$;
