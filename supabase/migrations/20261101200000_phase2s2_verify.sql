-- PHASE 2 step 2 verification. READ ONLY.
--
-- ── A CORRECTION TO MY OWN STEP-1 CONCLUSION ──────────────────────────
--
-- Step 1 said: a row that is INACTIVE while holding stock contradicts the rule
-- that set the status, therefore the STATUS is the stale side. The queue run
-- says otherwise. Across the four passes the dominant skip reason was
-- suspicious_zero_unconfirmed, 85 of 97 skips -- which is
-- rescue-inventory-asin refusing to write because Amazon returned ZERO total
-- stock while our row held a positive total and no recent zero confirmation
-- exists.
--
-- So for most of these rows Amazon says there is no stock. The inconsistency
-- was real, but the stale side is the QUANTITY, not the status: INACTIVE is
-- correct and the stored available/reserved/inbound is left over. I had the
-- direction backwards, and the guard is what caught it -- had the function
-- trusted the status rule and flipped these to ACTIVE, it would have published
-- phantom stock into Inventory Valuation, which is exactly the failure the
-- brief warned against.
DO $p$
DECLARE
  r record; v_uid uuid; v_changed int; v_claw numeric;
  v_val_rows int; v_val_units bigint; v_val_cost numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. WHAT ACTUALLY CHANGED ############';
  SELECT count(*) INTO v_changed
  FROM public.revive_backup_20261101 b
  JOIN public.inventory i ON i.id = b.id
  WHERE COALESCE(i.listing_status,'') <> COALESCE(b.listing_status,'')
     OR COALESCE(i.available,0) <> COALESCE(b.available,0)
     OR COALESCE(i.reserved,0)  <> COALESCE(b.reserved,0)
     OR COALESCE(i.inbound,0)   <> COALESCE(b.inbound,0);
  RAISE NOTICE '   rows changed: % of 139', v_changed;
  RAISE NOTICE '';
  RAISE NOTICE '   asin         | sku                  | status            | available | reserved | inbound';
  FOR r IN
    SELECT b.asin, COALESCE(b.sku,'(null)') AS sku,
           COALESCE(b.listing_status,'-') AS sb, COALESCE(i.listing_status,'-') AS sa,
           COALESCE(b.available,0) AS avb, COALESCE(i.available,0) AS ava,
           COALESCE(b.reserved,0) AS rvb,  COALESCE(i.reserved,0) AS rva,
           COALESCE(b.inbound,0) AS ibb,   COALESCE(i.inbound,0) AS iba
    FROM public.revive_backup_20261101 b
    JOIN public.inventory i ON i.id = b.id
    WHERE COALESCE(i.listing_status,'') <> COALESCE(b.listing_status,'')
       OR COALESCE(i.available,0) <> COALESCE(b.available,0)
       OR COALESCE(i.reserved,0)  <> COALESCE(b.reserved,0)
       OR COALESCE(i.inbound,0)   <> COALESCE(b.inbound,0)
    ORDER BY b.asin
  LOOP
    RAISE NOTICE '   % | % | %->% | %->% | %->% | %->%',
      rpad(r.asin,12), rpad(r.sku,20),
      rpad(r.sb,8), rpad(r.sa,8),
      lpad(r.avb::text,4), lpad(r.ava::text,4),
      lpad(r.rvb::text,3), lpad(r.rva::text,3),
      lpad(r.ibb::text,4), lpad(r.iba::text,4);
  END LOOP;
  IF v_changed = 0 THEN RAISE NOTICE '   (none)'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. B00LFXMBKI ############';
  FOR r IN
    SELECT COALESCE(b.sku,'(null)') AS sku,
           COALESCE(b.listing_status,'-') AS sb, COALESCE(i.listing_status,'-') AS sa,
           COALESCE(b.available,0) AS avb, COALESCE(i.available,0) AS ava,
           COALESCE(b.reserved,0) AS rvb,  COALESCE(i.reserved,0) AS rva,
           COALESCE(b.inbound,0) AS ibb,   COALESCE(i.inbound,0) AS iba,
           i.last_inventory_sync_at AS synced, COALESCE(i.source,'-') AS src
    FROM public.revive_backup_20261101 b
    JOIN public.inventory i ON i.id = b.id
    WHERE b.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku %', r.sku;
    RAISE NOTICE '      status    % -> %', r.sb, r.sa;
    RAISE NOTICE '      available % -> % | reserved % -> % | inbound % -> %',
      r.avb, r.ava, r.rvb, r.rva, r.ibb, r.iba;
    RAISE NOTICE '      synced % | source %', r.synced, r.src;
  END LOOP;
  RAISE NOTICE '   repricer view: auto-assign-bulk:1360 disqualifies';
  RAISE NOTICE '   NOT_IN_CATALOG/DELETED/INACTIVE/NOT_FOUND/INCOMPLETE.';
  FOR r IN
    SELECT COALESCE(listing_status,'-') AS st,
           CASE WHEN upper(COALESCE(listing_status,'')) IN
                     ('NOT_IN_CATALOG','DELETED','INACTIVE','NOT_FOUND','INCOMPLETE')
                THEN 'NO -- still disqualified' ELSE 'yes -- now manageable' END AS verdict
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP RAISE NOTICE '      status % -> repricer counts it as managed? %', r.st, r.verdict;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. INVENTORY VALUATION, BEFORE -> AFTER ############';
  SELECT count(*), sum(COALESCE(i.available,0)+COALESCE(i.reserved,0)),
         round(sum((COALESCE(i.available,0)+COALESCE(i.reserved,0))
               * COALESCE(i.cost, CASE WHEN COALESCE(i.units,0) > 0
                                       THEN COALESCE(i.amount,0)/i.units ELSE 0 END))::numeric,2)
    INTO v_val_rows, v_val_units, v_val_cost
  FROM public.inventory i
  WHERE i.user_id = v_uid
    AND NOT (upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED'));
  FOR r IN SELECT * FROM public.revive_valuation_20261101 WHERE phase='before' LOOP
    RAISE NOTICE '   before : % rows | % on-hand units | % at cost',
      r.rows, r.on_hand_units, r.value_at_cost;
    RAISE NOTICE '   after  : % rows | % on-hand units | % at cost',
      v_val_rows, v_val_units, v_val_cost;
    RAISE NOTICE '   change : % rows | % units | %',
      v_val_rows - r.rows, v_val_units - r.on_hand_units,
      round(v_val_cost - r.value_at_cost,2);
    RAISE NOTICE '   NOTE: this account is live, so some of any change is new';
    RAISE NOTICE '   stock arriving, not this run. The per-SKU table above is';
    RAISE NOTICE '   the attributable part.';
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. THE 6 TOMBSTONES: verified, not revived ############';
  FOR r IN
    SELECT t.asin, COALESCE(t.sku,'(null)') AS sku,
           COALESCE(i.listing_status,'-') AS st, t.sku90
    FROM public.revive_target_20261101 t
    JOIN public.inventory i ON i.id = t.id
    WHERE t.grp = 'tombstone' ORDER BY t.sku90 DESC
  LOOP
    RAISE NOTICE '   % | % | still % | own-SKU 90d sales %',
      rpad(r.asin,12), rpad(r.sku,20), rpad(r.st,16), r.sku90;
  END LOOP;
  RAISE NOTICE '   rescue-inventory-asin declined all of these by design';
  RAISE NOTICE '   (skipped_update_reason tombstoned:NOT_IN_CATALOG). Lifting a';
  RAISE NOTICE '   tombstone needs the deliberate force_relist two-step, which';
  RAISE NOTICE '   was NOT run.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 5. CONTROLS ############';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '   2026 clawback magnitude % | %', v_claw,
    CASE WHEN v_claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END;
  RAISE NOTICE '   nine-month applied NET -1765.91 -- untouched; this phase';
  RAISE NOTICE '   writes public.inventory only.';
  FOR r IN
    SELECT count(*) AS n, round(sum(abs(COALESCE(sales,0))),2) AS s
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP RAISE NOTICE '   fec rows % | sales % (was 49068 / 978840.93)', r.n, r.s; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- this report wrote nothing.';
END
$p$;
