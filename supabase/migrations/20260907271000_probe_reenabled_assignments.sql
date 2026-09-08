-- PROBE (read-only): assignments are being re-enabled after this morning's
-- cleanup. How many, and by what?
--
-- The numbers do not reconcile. After 20260907110000 disabled 238 dead rows,
-- the whole account held 696 enabled assignments. Momentum Smart alone now
-- reports 874 enabled over 640 ASINs, and 223 of those ASINs have NO inventory
-- row -- the exact orphan class that was disabled this morning on the grounds
-- that nothing had sold on them in a year.
--
-- Either something is re-enabling them or something is creating new ones.
-- Worth establishing before the seller relies on the cleanup having held.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== enabled assignments now, versus 696 after the cleanup ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_enabled) AS enabled,
           count(*) FILTER (WHERE NOT is_enabled) AS disabled
    FROM public.repricer_assignments WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % assignments | % enabled | % disabled', r.total, r.enabled, r.disabled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many still carry this morning cleanup stamp? ========';
  FOR r IN
    SELECT count(*) AS stamped,
           count(*) FILTER (WHERE is_enabled) AS stamped_but_now_enabled,
           count(*) FILTER (WHERE NOT is_enabled) AS still_disabled
    FROM public.repricer_assignments
    WHERE user_id = v_uid
      AND last_disabled_reason LIKE 'Dead listing, no sale in 365 days%'
  LOOP
    RAISE NOTICE '   % rows were disabled by the cleanup', r.stamped;
    RAISE NOTICE '   % of those are ENABLED again | % still disabled',
      r.stamped_but_now_enabled, r.still_disabled;
    IF r.stamped_but_now_enabled > 0 THEN
      RAISE NOTICE '   -> the cleanup did NOT hold; something re-enabled them';
    ELSE
      RAISE NOTICE '   -> the cleanup held; the growth is from NEW rows, not re-enabling';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== created or updated since the cleanup ran ========';
  FOR r IN
    SELECT count(*) FILTER (WHERE created_at > '2026-09-07 18:00:00+00') AS created_since,
           count(*) FILTER (WHERE updated_at > '2026-09-07 18:00:00+00') AS updated_since,
           count(*) FILTER (WHERE created_at > '2026-09-07 18:00:00+00' AND is_enabled) AS created_enabled
    FROM public.repricer_assignments WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % created since 18:00 UTC (% of them enabled) | % updated',
      r.created_since, r.created_enabled, r.updated_since;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== who last touched the enabled ones? ========';
  FOR r IN
    SELECT COALESCE(last_disabled_by,'(never disabled)') AS who,
           count(*) AS n,
           count(*) FILTER (WHERE is_enabled) AS enabled
    FROM public.repricer_assignments WHERE user_id = v_uid
    GROUP BY 1 ORDER BY n DESC LIMIT 6
  LOOP
    RAISE NOTICE '   last_disabled_by=%-22s : % rows (% enabled)', r.who, r.n, r.enabled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== enabled assignments whose SKU has no inventory row ========';
  FOR r IN
    SELECT count(*) AS orphaned_enabled,
           count(DISTINCT a.asin) AS orphan_asins
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
  LOOP
    RAISE NOTICE '   % enabled assignments over % ASINs have no inventory row',
      r.orphaned_enabled, r.orphan_asins;
    RAISE NOTICE '   (this morning it was 257, of which 231 were disabled)';
  END LOOP;
END
$probe$;
