-- PROBE (read-only): are the 344 enabled US Momentum Builder assignments
-- actually live listings, or dead ones the repricer never switched off?
--
-- The seller's read is that most of them are no longer active. If so, moving
-- them to Momentum Smart is the wrong operation entirely -- they should be
-- DISABLED, not reassigned, and the enabled counts I quoted are overstating
-- how much is really being repriced.
--
-- Same ghost definition the UI uses (src/lib/ghostFilter.ts and
-- public.is_ghost_inventory_row): NOT_IN_CATALOG or DELETED, INACTIVE /
-- INCOMPLETE / SUPPRESSED, an "amzn.gr." SKU, or zero total stock while the
-- status is not ACTIVE.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== enabled assignments vs the state of their listing ========';
  FOR r IN
    SELECT rr.name AS rule, a.marketplace,
           count(*) AS enabled_assignments,
           count(*) FILTER (WHERE i.sku IS NULL) AS no_inventory_row,
           count(*) FILTER (WHERE upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')) AS dead_status,
           count(*) FILTER (WHERE upper(COALESCE(i.listing_status,'')) LIKE '%INACTIVE%'
                              OR upper(COALESCE(i.listing_status,'')) IN ('INCOMPLETE','SUPPRESSED')) AS inactive_status,
           count(*) FILTER (WHERE COALESCE(i.available,0)+COALESCE(i.reserved,0)
                                 +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) = 0) AS zero_stock,
           count(*) FILTER (WHERE upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
                              AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                                 +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0) AS genuinely_live
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND rr.name ILIKE '%Momentum%'
    GROUP BY rr.name, a.marketplace
    ORDER BY a.marketplace, enabled_assignments DESC
  LOOP
    RAISE NOTICE '   % | %-18s | % enabled | no inv % | dead % | inactive % | zero stock % | GENUINELY LIVE %',
      r.marketplace, left(r.rule,18), r.enabled_assignments, r.no_inventory_row,
      r.dead_status, r.inactive_status, r.zero_stock, r.genuinely_live;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== across ALL your enabled assignments, every rule ========';
  FOR r IN
    SELECT count(*) AS enabled,
           count(*) FILTER (WHERE upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
                              AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                                 +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0) AS live,
           count(*) FILTER (WHERE i.sku IS NULL) AS orphaned,
           count(*) FILTER (WHERE lower(COALESCE(a.sku,'')) LIKE 'amzn.gr.%') AS graded_sku
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled
  LOOP
    RAISE NOTICE '   % enabled | % genuinely live | % have no inventory row at all | % are graded/used SKUs',
      r.enabled, r.live, r.orphaned, r.graded_sku;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== when were the dead ones last evaluated? ========';
  FOR r IN
    SELECT CASE
             WHEN a.last_evaluated_at IS NULL THEN 'never'
             WHEN a.last_evaluated_at > now() - interval '1 day'  THEN 'today'
             WHEN a.last_evaluated_at > now() - interval '7 days' THEN 'this week'
             WHEN a.last_evaluated_at > now() - interval '30 days' THEN 'this month'
             ELSE 'over a month ago'
           END AS bucket,
           count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled
      AND NOT (upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
               AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                  +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0)
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   dead-but-enabled, last evaluated %: %', r.bucket, r.n;
  END LOOP;
END
$probe$;
