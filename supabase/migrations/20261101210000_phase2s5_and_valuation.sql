-- PHASE 2 step 5 + the valuation question + picking step 3's subject.
-- READ ONLY. Nothing written, no Amazon call.
--
-- Order note: the read-only items run BEFORE step 3 because item 3 identifies
-- which rows Amazon confirmed as zero, and step 3 needs the opposite -- a row
-- with stock Amazon confirmed RECENTLY. Choosing the subject before knowing
-- that would be guessing.
--
-- The 85 are identifiable exactly: mark_inventory_refresh_skipped writes the
-- reason into inventory_refresh_queue.last_error with status 'skipped', so the
-- decision is on record per row rather than only in an aggregate count.
DO $p$
DECLARE
  r record; v_uid uuid; v_n int; v_units bigint; v_val numeric; v_claw numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## A. THE VALUATION QUESTION ########';
  RAISE NOTICE 'inventory-valuation-core.ts:225 skips only NOT_IN_CATALOG and';
  RAISE NOTICE 'DELETED, so an INACTIVE row WITH stock is fully counted.';
  RAISE NOTICE '';

  CREATE TEMP TABLE zconf AS
  SELECT DISTINCT q.asin, q.sku
  FROM public.inventory_refresh_queue q
  WHERE q.user_id = v_uid AND q.status = 'skipped'
    AND COALESCE(q.last_error,'') ILIKE '%suspicious_zero%';

  SELECT count(*) INTO v_n FROM zconf;
  RAISE NOTICE 'queue rows recorded suspicious_zero_unconfirmed: % (asin,sku) pairs', v_n;

  SELECT count(*), sum(COALESCE(i.available,0)+COALESCE(i.reserved,0)),
         round(sum((COALESCE(i.available,0)+COALESCE(i.reserved,0))
               * COALESCE(i.cost, CASE WHEN COALESCE(i.units,0) > 0
                                       THEN COALESCE(i.amount,0)/i.units ELSE 0 END))::numeric,2)
    INTO v_n, v_units, v_val
  FROM public.inventory i
  JOIN zconf z ON z.asin = i.asin AND z.sku = i.sku
  WHERE i.user_id = v_uid
    AND NOT (upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED'))
    AND COALESCE(i.available,0)+COALESCE(i.reserved,0) > 0;
  RAISE NOTICE '';
  RAISE NOTICE '>>> rows counted in valuation where Amazon reported ZERO: %', v_n;
  RAISE NOTICE '>>> on-hand units they contribute                      : %',
    COALESCE(v_units,0);
  RAISE NOTICE '>>> DOLLARS of overstatement at cost                   : %',
    COALESCE(v_val,0);
  RAISE NOTICE '    (against a total valuation of 1,294,897.73)';
  RAISE NOTICE '';
  RAISE NOTICE '    CAVEAT, stated because it changes the meaning: Amazon';
  RAISE NOTICE '    returning zero ONCE is why the guard exists --';
  RAISE NOTICE '    hasRecentZeroConfirmation()''s header records that SP-API';
  RAISE NOTICE '    Summaries emits intermittent FALSE zeros. So this is the';
  RAISE NOTICE '    exposure if Amazon is right, not a proven overstatement.';
  RAISE NOTICE '    One zero is a signal; two independent zeros are evidence.';

  RAISE NOTICE '';
  RAISE NOTICE 'the 12 largest, so the shape is visible:';
  FOR r IN
    SELECT i.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.listing_status,'-') AS st,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           round(((COALESCE(i.available,0)+COALESCE(i.reserved,0))
                 * COALESCE(i.cost, CASE WHEN COALESCE(i.units,0) > 0
                                         THEN COALESCE(i.amount,0)/i.units ELSE 0 END))::numeric,2) AS val,
           CASE WHEN i.last_inventory_sync_at IS NULL THEN 'never'
                ELSE (extract(epoch from (now()-i.last_inventory_sync_at))/86400)::int || 'd'
           END AS age
    FROM public.inventory i
    JOIN zconf z ON z.asin = i.asin AND z.sku = i.sku
    WHERE i.user_id = v_uid
      AND NOT (upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED'))
      AND COALESCE(i.available,0)+COALESCE(i.reserved,0) > 0
    ORDER BY val DESC NULLS LAST LIMIT 12
  LOOP
    RAISE NOTICE '   % | % | % | av % rv % | % | sync %',
      rpad(r.asin,12), rpad(r.sku,20), rpad(r.st,9),
      lpad(r.av::text,3), lpad(r.rv::text,3), lpad(r.val::text,9), r.age;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## B. B00LFXMBKI''S FOUR ASSIGNMENTS ########';
  FOR r IN
    SELECT a.id, COALESCE(a.sku,'(null)') AS sku, COALESCE(a.status,'-') AS st,
           a.is_enabled AS en, COALESCE(a.is_priority,false) AS pri,
           COALESCE(a.is_listing_inactive_not_buyable,false) AS nb,
           a.listing_inactive_detected_at AS det,
           a.created_at, a.updated_at
    FROM public.repricer_assignments a
    WHERE a.user_id = v_uid AND a.asin = 'B00LFXMBKI'
    ORDER BY a.created_at
  LOOP
    RAISE NOTICE '   % | sku % | status % | enabled % | pri % | nb %',
      r.id, r.sku, rpad(r.st,16), r.en, r.pri, r.nb;
    RAISE NOTICE '      created % | updated % | nb detected %',
      r.created_at, r.updated_at, r.det;
  END LOOP;
  RAISE NOTICE '   all four share one SKU, so three are duplicates by any';
  RAISE NOTICE '   reading. Which is canonical is a judgement: newest-updated,';
  RAISE NOTICE '   or the single enabled one if only one is enabled.';
  SELECT count(*) INTO v_n FROM public.repricer_assignments
   WHERE user_id = v_uid AND asin = 'B00LFXMBKI' AND is_enabled;
  RAISE NOTICE '   enabled among them: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   is a unique constraint missing? duplicates across the table:';
  FOR r IN
    SELECT count(*) AS dup_groups, sum(n) AS dup_rows FROM (
      SELECT asin, sku, count(*) AS n FROM public.repricer_assignments
      WHERE user_id = v_uid GROUP BY asin, sku HAVING count(*) > 1) x
  LOOP
    RAISE NOTICE '      % (asin,sku) pairs with more than one assignment, % rows total',
      COALESCE(r.dup_groups,0), COALESCE(r.dup_rows,0);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## C. THE NEVER-CLEARING FLAG ########';
  FOR r IN
    SELECT count(*) FILTER (WHERE COALESCE(is_listing_inactive_not_buyable,false)) AS flagged,
           count(*) FILTER (WHERE listing_inactive_cleared_at IS NOT NULL) AS ever_cleared,
           min(listing_inactive_detected_at) AS first_det,
           max(listing_inactive_detected_at) AS last_det,
           max(listing_inactive_last_checked_at) AS last_check
    FROM public.repricer_assignments WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   flagged % | ever cleared % | detections % .. %',
      r.flagged, r.ever_cleared, r.first_det, r.last_det;
    RAISE NOTICE '   newest last_checked_at: %', r.last_check;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## D. STEP 3''S SUBJECT: a revived row with FRESH stock ########';
  RAISE NOTICE 'clean-ghost-listings holds a row back only when Amazon confirmed';
  RAISE NOTICE 'stock within STOCK_EVIDENCE_MAX_AGE_MS = 7 days. Candidates among';
  RAISE NOTICE 'the 14 revived rows, best first:';
  FOR r IN
    SELECT b.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib,
           COALESCE(i.available,0)+COALESCE(i.reserved,0) AS onhand,
           (extract(epoch from (now()-i.last_inventory_sync_at))/3600)::int AS age_h,
           COALESCE(i.listing_status,'-') AS st
    FROM public.revive_backup_20261101 b
    JOIN public.inventory i ON i.id = b.id
    WHERE COALESCE(i.listing_status,'') <> COALESCE(b.listing_status,'')
    ORDER BY (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)) DESC
    LIMIT 6
  LOOP
    RAISE NOTICE '   % | % | av % rv % ib % | on-hand % | synced %h ago | %',
      rpad(r.asin,12), rpad(r.sku,20), lpad(r.av::text,3), lpad(r.rv::text,3),
      lpad(r.ib::text,4), lpad(r.onhand::text,3), lpad(r.age_h::text,4), r.st;
  END LOOP;
  RAISE NOTICE '   NOTE: inbound does NOT count as held-back stock -- the gate';
  RAISE NOTICE '   reads available+reserved. A row with 25 inbound and 0 on hand';
  RAISE NOTICE '   would NOT be held back, so it is the wrong subject.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## CONTROLS ########';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '   clawback % | % | nine-month NET -1765.91', v_claw,
    CASE WHEN v_claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END;

  DROP TABLE zconf;
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
