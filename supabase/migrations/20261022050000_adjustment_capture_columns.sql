-- Capture columns for FBA adjustment provenance. ADDITIVE ONLY.
--
-- Nothing is backfilled, no existing value is touched, no RPC changes. Every
-- column is nullable, so existing rows stay valid and the P&L -- which reads
-- only the money columns -- cannot move.
--
-- WHY. fetch-profit-loss's AdjustmentEventList writer discards everything that
-- would let a reimbursement be explained or attributed:
--   AdjustmentType  used only to pick a branch, never stored
--   SellerSKU       never read at all, though Amazon ALWAYS sends it
--   Quantity        never read
--   PostedDate      truncated with .split('T')[0], so the time is lost
--   the payload     raw_event is NULL on all 122,737 rows
--
-- Measured against the live Finances API on 2026-10-22 for 2026-10-18..22
-- (read-only probe, 63 adjustment items):
--
--   MISSING_FROM_INBOUND          43 items  +638.68  all positive
--   REVERSAL_REIMBURSEMENT         6 items   +97.46  all positive
--   FREE_REPLACEMENT_REFUND_ITEMS  3 items   +44.04  all positive
--   WAREHOUSE_LOST                 6 items   +27.12  all positive
--   COMPENSATED_CLAWBACK           3 items   -16.31  ALL NEGATIVE
--   WAREHOUSE_DAMAGE               2 items    +5.96  all positive
--
-- Two things that changes:
--
-- 1. SellerSKU is present on every single item while ASIN is null on every
--    single item. The writer stores item.ASIN and ignores item.SellerSKU,
--    which is exactly why no reimbursement can be attributed to a SKU.
--    seller_sku below fixes that going forward. asin is deliberately NOT
--    repurposed: it is part of the upsert key
--    (user_id, event_type, event_date, amazon_order_id, asin) and changing
--    what lands in it would fork every future row away from its existing one.
--
-- 2. PostedDate carries a full UTC timestamp, and the truncation is why our
--    day totals disagree with InventoryLab. The big MISSING_FROM_INBOUND batch
--    at 2026-10-19T01:40:52Z is 2026-10-18 18:40 Pacific -- InventoryLab files
--    it under Oct 18, we file it under Oct 19. posted_at keeps the instant so
--    a Pacific-day view becomes possible later without another re-pull.
--
-- This migration does NOT change any sign and does NOT address the
-- COMPENSATED_CLAWBACK rows being dropped entirely by the writer's final
-- `else if (amount > 0)` branch. Both are P&L-affecting and need their own
-- approval.

ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS adjustment_type text,
  ADD COLUMN IF NOT EXISTS seller_sku      text,
  ADD COLUMN IF NOT EXISTS quantity        integer,
  ADD COLUMN IF NOT EXISTS posted_at       timestamptz;

COMMENT ON COLUMN public.financial_events_cache.adjustment_type IS
  'Amazon AdjustmentEvent.AdjustmentType verbatim (MISSING_FROM_INBOUND, REVERSAL_REIMBURSEMENT, COMPENSATED_CLAWBACK, WAREHOUSE_LOST, WAREHOUSE_DAMAGE, FREE_REPLACEMENT_REFUND_ITEMS...). Populated for adjustment rows from 2026-10-22; NULL on everything written before, and on non-adjustment event types.';

COMMENT ON COLUMN public.financial_events_cache.seller_sku IS
  'AdjustmentItem.SellerSKU verbatim. Amazon sends this on every adjustment item while leaving ASIN null, so this is the only way to attribute a reimbursement to a SKU. Not part of the upsert key.';

COMMENT ON COLUMN public.financial_events_cache.quantity IS
  'AdjustmentItem.Quantity: units reimbursed or clawed back. Needed to tell a 19-unit loss from a 1-unit one at the same dollar value.';

COMMENT ON COLUMN public.financial_events_cache.posted_at IS
  'AdjustmentEvent.PostedDate as a full timestamptz. event_date is this truncated to a UTC calendar day, which is why per-day totals disagree with InventoryLab (it files by Pacific). Keep both: event_date drives existing queries, posted_at makes a correct day-bucketing possible later.';

-- Partial index: only adjustment rows will carry a type, and this is the
-- column every future diagnosis will filter on.
CREATE INDEX IF NOT EXISTS idx_fec_adjustment_type
  ON public.financial_events_cache (user_id, adjustment_type, event_date)
  WHERE adjustment_type IS NOT NULL;

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== columns now present ==';
  FOR r IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache'
      AND column_name IN ('adjustment_type','seller_sku','quantity','posted_at','raw_event')
    ORDER BY column_name
  LOOP
    RAISE NOTICE '   % | % | nullable %', rpad(r.column_name,16), rpad(r.data_type,26), r.is_nullable;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== baseline BEFORE the writer ships (all should be 0 / NULL) ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(adjustment_type) AS with_type,
           count(seller_sku) AS with_sku,
           count(quantity) AS with_qty,
           count(posted_at) AS with_posted,
           count(raw_event) AS with_raw
    FROM public.financial_events_cache
  LOOP
    RAISE NOTICE '   % rows | type % | sku % | qty % | posted % | raw %',
      r.rows, r.with_type, r.with_sku, r.with_qty, r.with_posted, r.with_raw;
  END LOOP;
END
$p$;
