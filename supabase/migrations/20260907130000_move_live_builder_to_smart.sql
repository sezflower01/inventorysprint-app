-- Move the 41 live listings from Momentum Builder to Momentum Smart, and make
-- Momentum Smart the default for new ASINs.
--
-- ---- WHY THIS IS 41 AND NOT 2,215 ---------------------------------------
--
-- The original ask was "move everything". Measured, that would have moved
-- mostly corpses: of 344 enabled US Builder assignments only 23 were live, and
-- 238 dead ones were disabled in 20260907110000. What remains worth moving is
-- 41 real listings -- US 23, CA 7, BR 6, MX 5 -- of which 34 sold within 90
-- days. The seller reviewed the list item by item before approving.
--
-- ---- SCOPE ---------------------------------------------------------------
--
-- ONLY enabled Builder assignments whose listing is genuinely live: the
-- inventory row exists, listing_status is ACTIVE, and stock exists somewhere
-- across available/reserved/inbound/unfulfilled.
--
-- Deliberately NOT moved: the ~109 assignments still enabled on Builder that
-- are not currently live. Those were held back earlier because they sold
-- within the year, and moving a dormant row's rule decides nothing today while
-- making the change harder to reason about. They keep Builder until they
-- restock, at which point they are a visible decision rather than a silent one.
--
-- ---- THE DEFAULT ---------------------------------------------------------
--
-- Momentum Builder was the default, so every new ASIN landed there regardless
-- of this move -- the drift that started the whole investigation. Switching
-- the default to Momentum Smart is what stops it recurring. A partial unique
-- index already enforces one default per user, so the old flag has to be
-- cleared in the same statement rather than before it.
--
-- Nothing about either rule's settings changes. This moves assignments and
-- moves a flag.

BEGIN;

CREATE TEMP TABLE _move ON COMMIT DROP AS
SELECT a.id, a.user_id, a.asin, a.sku, a.marketplace
FROM public.repricer_assignments a
JOIN public.repricer_rules rr ON rr.id = a.rule_id
JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
WHERE a.is_enabled
  AND rr.name = 'Momentum Builder'
  AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
  AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
     +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0;

DO $$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '================ BEFORE ================';
  SELECT count(*) INTO n FROM _move;
  RAISE NOTICE 'moving % live assignments', n;
  FOR r IN SELECT marketplace, count(*) AS c FROM _move GROUP BY 1 ORDER BY c DESC LOOP
    RAISE NOTICE '   % : %', r.marketplace, r.c;
  END LOOP;

  FOR r IN
    SELECT rr.name, count(a.id) AS total,
           count(a.id) FILTER (WHERE a.is_enabled) AS enabled
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    WHERE rr.name IN ('Momentum Builder','Momentum Smart')
    GROUP BY rr.id, rr.name ORDER BY total DESC
  LOOP
    RAISE NOTICE '   %-20s : % assignments (% enabled)', r.name, r.total, r.enabled;
  END LOOP;

  IF n = 0 THEN
    RAISE EXCEPTION 'nothing matched -- refusing to commit a no-op that looks like success';
  END IF;
END $$;

-- 1. Move the assignments.
UPDATE public.repricer_assignments a
   SET rule_id = (SELECT rr2.id FROM public.repricer_rules rr2
                   WHERE rr2.user_id = a.user_id AND rr2.name = 'Momentum Smart'
                   ORDER BY rr2.created_at LIMIT 1),
       updated_at = now()
  FROM _move m
 WHERE a.id = m.id;

-- 2. Move the default. Cleared and set in one statement because the partial
--    unique index would reject two defaults existing even momentarily.
UPDATE public.repricer_rules rr
   SET is_default = (rr.name = 'Momentum Smart'),
       updated_at = now()
 WHERE rr.user_id IN (SELECT DISTINCT user_id FROM _move)
   AND (rr.is_default = true OR rr.name = 'Momentum Smart');

DO $$
DECLARE r record; v_left int; v_defaults int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================ AFTER ================';
  FOR r IN
    SELECT rr.name, count(a.id) AS total,
           count(a.id) FILTER (WHERE a.is_enabled) AS enabled,
           rr.is_default
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    WHERE rr.name IN ('Momentum Builder','Momentum Smart')
    GROUP BY rr.id, rr.name, rr.is_default ORDER BY total DESC
  LOOP
    RAISE NOTICE '   %-20s : % assignments (% enabled) default=%',
      r.name, r.total, r.enabled, r.is_default;
  END LOOP;

  -- Post-condition 1: no live listing may remain on Builder.
  SELECT count(*) INTO v_left
  FROM public.repricer_assignments a
  JOIN public.repricer_rules rr ON rr.id = a.rule_id
  JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
  WHERE a.is_enabled AND rr.name = 'Momentum Builder'
    AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
    AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
       +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0;
  RAISE NOTICE 'live listings still on Builder: % (must be 0)', v_left;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'move incomplete -- % live rows remain on Builder', v_left;
  END IF;

  -- Post-condition 2: exactly one default per affected user, and it is Smart.
  SELECT count(*) INTO v_defaults
  FROM public.repricer_rules rr
  WHERE rr.user_id IN (SELECT DISTINCT user_id FROM _move)
    AND rr.is_default = true AND rr.name <> 'Momentum Smart';
  RAISE NOTICE 'defaults that are NOT Momentum Smart: % (must be 0)', v_defaults;
  IF v_defaults <> 0 THEN
    RAISE EXCEPTION 'default not switched cleanly';
  END IF;
END $$;

COMMIT;
