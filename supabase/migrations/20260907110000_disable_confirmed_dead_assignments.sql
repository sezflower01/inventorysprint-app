-- Disable assignments that are provably dead. Do NOT reassign them.
--
-- ---- WHY DISABLE RATHER THAN MOVE ---------------------------------------
--
-- The seller asked to move everything from Momentum Builder to Momentum Smart,
-- then spotted that the 344 enabled US Builder rows were probably not live.
-- They were right: only 23 of the 344 are genuinely live, against 232 of 235
-- on Momentum Smart. The live US book is ALREADY on Smart. Reassigning would
-- have moved corpses and taught us nothing.
--
-- Across all rules, 933 assignments are enabled but only 512 are live, and 220
-- dead-but-enabled were evaluated on 2026-09-07 -- real SP-API and Keepa quota
-- spent pricing listings that do not exist.
--
-- ---- WHAT WAS VERIFIED BEFORE SWITCHING ANYTHING OFF --------------------
--
-- The seller's condition was explicit: do not disable a real, sellable listing
-- because a sync missed it. So SALES were used as the test -- Amazon reports
-- what sold independently of our inventory sync, so a recent sale is proof of
-- life that no local table can contradict.
--
--   257 orphaned + enabled (no inventory row for that SKU)
--   231 sold NOTHING in 365 days      <- disabled here
--    26 sold something within a year  <- LEFT ALONE
--     3 of those sold within 90 days, 1 within 30
--
-- Those 26 are held back deliberately. 223 of the 257 also exist in
-- created_listings and many carry "amzn.gr." graded SKUs, so a missing
-- inventory row is expected for them rather than evidence of a sync failure --
-- but "expected" is not "safe to switch off", and a sale in the last month
-- outranks every other signal.
--
-- ---- SECOND GROUP: US terminal / inactive -------------------------------
--
-- cleanup-dead-assignments checks intl_listing_status with
-- .neq("marketplace","US"), so US never gets the INACTIVE / NOT_FOUND check at
-- all. Those rows are caught here on the same sales-proof condition.
--
-- Zero stock alone is deliberately NOT a reason to disable: an ACTIVE listing
-- awaiting restock should keep its assignment.
--
-- Reversible: every row keeps last_disabled_by / last_disabled_reason, so the
-- set is re-selectable and re-enablable.

BEGIN;

CREATE TEMP TABLE _dead ON COMMIT DROP AS
WITH sold AS (
  SELECT a.id,
         COALESCE((SELECT sum(so.quantity) FROM public.sales_orders so
                    WHERE so.user_id = a.user_id AND so.asin = a.asin
                      AND COALESCE(so.is_cancelled,false) = false
                      AND so.order_date >= current_date - 365), 0) AS units_365d
  FROM public.repricer_assignments a
  WHERE a.is_enabled
)
SELECT a.id, a.user_id, a.asin, a.sku, a.marketplace,
       CASE WHEN i.sku IS NULL THEN 'orphan_no_inventory_row'
            ELSE 'listing_terminal_or_inactive' END AS reason
FROM public.repricer_assignments a
JOIN sold s ON s.id = a.id
LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
WHERE a.is_enabled
  -- Proof of life beats every other signal. Nothing that sold in the last
  -- year is touched, whatever the local tables say about it.
  AND s.units_365d = 0
  AND (
        i.sku IS NULL
     OR upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED','NOT_FOUND')
     OR upper(COALESCE(i.listing_status,'')) IN ('INACTIVE','INCOMPLETE','SUPPRESSED')
     OR upper(COALESCE(i.listing_status,'')) LIKE '%INACTIVE%'
      );

DO $$
DECLARE r record; n int;
BEGIN
  SELECT count(*) INTO n FROM _dead;
  RAISE NOTICE '================ BEFORE ================';
  RAISE NOTICE 'to disable: % assignments', n;
  FOR r IN SELECT reason, marketplace, count(*) AS c FROM _dead GROUP BY 1,2 ORDER BY c DESC LOOP
    RAISE NOTICE '   % | % : %', r.marketplace, r.reason, r.c;
  END LOOP;
  FOR r IN
    SELECT count(*) AS enabled_before,
           count(*) FILTER (WHERE id IN (SELECT id FROM _dead)) AS being_disabled
    FROM public.repricer_assignments WHERE is_enabled
  LOOP
    RAISE NOTICE 'enabled now: % | disabling % | will remain %',
      r.enabled_before, r.being_disabled, r.enabled_before - r.being_disabled;
  END LOOP;
END $$;

UPDATE public.repricer_assignments a
   SET is_enabled = false,
       manual_paused = false,
       last_disabled_by = 'cleanup',
       last_disabled_reason = 'Dead listing, no sale in 365 days (' || d.reason || ')',
       last_disabled_at = now(),
       updated_at = now()
  FROM _dead d
 WHERE a.id = d.id;

DO $$
DECLARE r record; v_left int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================ AFTER ================';
  FOR r IN
    SELECT count(*) AS enabled,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.inventory i
             WHERE i.user_id = a.user_id AND i.sku = a.sku
               AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
               AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                  +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0)) AS live
    FROM public.repricer_assignments a WHERE a.is_enabled
  LOOP
    RAISE NOTICE 'enabled after: % | of which genuinely live: %', r.enabled, r.live;
  END LOOP;

  -- Post-condition: nothing that sold in the last year may have been disabled.
  SELECT count(*) INTO v_left
  FROM public.repricer_assignments a
  WHERE a.last_disabled_reason LIKE 'Dead listing, no sale in 365 days%'
    AND a.last_disabled_at > now() - interval '5 minutes'
    AND EXISTS (SELECT 1 FROM public.sales_orders so
                 WHERE so.user_id = a.user_id AND so.asin = a.asin
                   AND COALESCE(so.is_cancelled,false) = false
                   AND so.order_date >= current_date - 365);
  RAISE NOTICE 'sanity: rows disabled that DID sell in the last year: % (must be 0)', v_left;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'refusing to commit -- % rows with sales were disabled', v_left;
  END IF;
END $$;

COMMIT;
