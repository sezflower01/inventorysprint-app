-- PHASE 2 step 2: back up the 137, snapshot valuation, enqueue at priority 1.
--
-- THE SET, as approved:
--   * 6  NOT_IN_CATALOG rows whose OWN SKU sold in the last 90 days
--   * 131 INACTIVE rows holding stock (available+reserved+inbound > 0), which
--     contradict the rule every writer uses to set that status
--
-- ── WHY THE QUEUE RATHER THAN DIRECT CALLS ────────────────────────────
--
-- inventory_refresh_queue -> inventory-refresh-worker -> rescue-inventory-asin
-- is the designed path, and it satisfies the write constraint by construction:
-- rescue-inventory-asin reads Amazon's FBA Inventory Summaries and writes
-- available/reserved/inbound FROM THAT RESPONSE, deriving listing_status as
-- (available+reserved+inbound) > 0 ? ACTIVE : INACTIVE. There is no code path
-- in it that invents a quantity, so "never set a quantity we invented" is a
-- property of the function, not a promise about how it is called.
--
-- It also already does the right thing on the two failure modes the brief asks
-- about: a row Amazon does not confirm records skipped_update_reason
-- ('no_exact_seller_sku_match' or 'no_summary_any_marketplace') and writes
-- nothing, and a throttle leaves the queue row retryable.
--
-- ── WHAT THIS CANNOT DO, STATED NOW ───────────────────────────────────
--
-- The 6 NOT_IN_CATALOG rows will be VERIFIED but NOT revived by this path.
-- rescue-inventory-asin declines any tombstoned row on purpose
-- (skippedUpdateReason = 'tombstoned:<status>', index.ts:579), and the
-- fn_protect_ghost_tombstone trigger would silently revert the status anyway
-- unless the write sets source = 'force_relist'. So this pass tells us what
-- Amazon says about all 137 and revives only the 131. Lifting a tombstone is a
-- separate, deliberate two-step write and is NOT done here.
DO $p$
DECLARE
  v_uid uuid; v_tomb int; v_lag int; v_backed int; v_enq int; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  -- 1. define the set once, in a table, so every later step uses the
  --    same 137 rather than re-deriving a set that may have drifted
  ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='revive_target_20261101') THEN
    SELECT count(*) INTO v_backed FROM public.revive_target_20261101;
    RAISE NOTICE '== target set already exists (% rows) -- reusing it ==', v_backed;
  ELSE
    CREATE TABLE public.revive_target_20261101 AS
    WITH by_sku AS (
      SELECT seller_sku, sum(quantity) AS u90 FROM public.sales_orders
      WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
        AND order_date >= current_date - 90 AND seller_sku IS NOT NULL
      GROUP BY seller_sku)
    SELECT i.id, i.asin, i.sku, i.listing_status AS status_before,
           COALESCE(i.available,0) AS av_before,
           COALESCE(i.reserved,0)  AS rv_before,
           COALESCE(i.inbound,0)   AS ib_before,
           CASE WHEN upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
                THEN 'tombstone' ELSE 'inactive_lag' END AS grp,
           COALESCE(k.u90,0) AS sku90,
           now() AS captured_at
    FROM public.inventory i
    LEFT JOIN by_sku k ON k.seller_sku = i.sku
    WHERE i.user_id = v_uid AND i.asin IS NOT NULL AND i.sku IS NOT NULL
      AND (
        -- the 6
        (upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
         AND COALESCE(k.u90,0) > 0)
        OR
        -- the 131
        (upper(COALESCE(i.listing_status,'')) = 'INACTIVE'
         AND COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0) > 0)
      );
    ALTER TABLE public.revive_target_20261101 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.revive_target_20261101 FROM PUBLIC, anon, authenticated;
  END IF;

  SELECT count(*) FILTER (WHERE grp='tombstone'),
         count(*) FILTER (WHERE grp='inactive_lag')
    INTO v_tomb, v_lag FROM public.revive_target_20261101;
  RAISE NOTICE '   tombstones % (expect 6) | inactive lag % (expect 131) | total %',
    v_tomb, v_lag, v_tomb + v_lag;

  ------------------------------------------------------------------
  -- 2. full-row backup, count verified
  ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='revive_backup_20261101') THEN
    SELECT count(*) INTO v_backed FROM public.revive_backup_20261101;
    RAISE NOTICE '== backup already exists (% rows) -- NOT overwriting ==', v_backed;
  ELSE
    CREATE TABLE public.revive_backup_20261101 AS
    SELECT s.*, now() AS backed_up_at
    FROM public.inventory s
    WHERE s.id IN (SELECT id FROM public.revive_target_20261101);
    SELECT count(*) INTO v_backed FROM public.revive_backup_20261101;
    IF v_backed <> v_tomb + v_lag THEN
      RAISE EXCEPTION 'backup % rows but target % -- refusing to proceed',
        v_backed, v_tomb + v_lag;
    END IF;
    ALTER TABLE public.revive_backup_20261101 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.revive_backup_20261101 FROM PUBLIC, anon, authenticated;
    COMMENT ON TABLE public.revive_backup_20261101 IS
      'Pre-change copy of the 137 inventory rows targeted by the 2026-11-01 revive. Restore: UPDATE inventory SET listing_status=b.listing_status, available=b.available, reserved=b.reserved, inbound=b.inbound FROM revive_backup_20261101 b WHERE inventory.id=b.id.';
    RAISE NOTICE '== backup created: % rows, COUNT VERIFIED ==', v_backed;
  END IF;

  ------------------------------------------------------------------
  -- 3. valuation snapshot, BEFORE
  ------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='revive_valuation_20261101') THEN
    CREATE TABLE public.revive_valuation_20261101 AS
    SELECT 'before'::text AS phase,
           count(*) AS rows,
           sum(COALESCE(i.available,0) + COALESCE(i.reserved,0)) AS on_hand_units,
           round(sum((COALESCE(i.available,0)+COALESCE(i.reserved,0))
                 * COALESCE(i.cost,
                     CASE WHEN COALESCE(i.units,0) > 0
                          THEN COALESCE(i.amount,0)/i.units ELSE 0 END))::numeric,2) AS value_at_cost,
           now() AS captured_at
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND NOT (upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED'));
    ALTER TABLE public.revive_valuation_20261101 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.revive_valuation_20261101 FROM PUBLIC, anon, authenticated;
  END IF;
  FOR r IN SELECT * FROM public.revive_valuation_20261101 WHERE phase='before' LOOP
    RAISE NOTICE '== valuation BEFORE: % rows | % on-hand units | % at cost ==',
      r.rows, r.on_hand_units, r.value_at_cost;
  END LOOP;

  ------------------------------------------------------------------
  -- 4. enqueue at the top priority. B00LFXMBKI first, as asked.
  ------------------------------------------------------------------
  INSERT INTO public.inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
  SELECT v_uid, t.asin, t.sku, 'US', 'pending',
         CASE WHEN t.asin = 'B00LFXMBKI' THEN 0 ELSE 1 END
  FROM public.revive_target_20261101 t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventory_refresh_queue q
    WHERE q.user_id = v_uid AND q.asin = t.asin AND q.sku = t.sku
      AND q.marketplace = 'US' AND q.status IN ('pending','running'));
  v_enq := (SELECT count(*) FROM public.inventory_refresh_queue
             WHERE user_id = v_uid AND status = 'pending' AND priority <= 1);
  RAISE NOTICE '== queued at priority 0/1: % rows pending ==', v_enq;
  RAISE NOTICE '   B00LFXMBKI is priority 0 so the worker takes it first.';
  RAISE NOTICE '';
  RAISE NOTICE '   NOTHING IN inventory WAS CHANGED. Backup, snapshot and queue';
  RAISE NOTICE '   rows only -- the worker does the Amazon calls and the writes.';
END
$p$;
