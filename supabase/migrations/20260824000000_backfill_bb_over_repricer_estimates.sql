-- Backfill: promote qualified own-Buy-Box estimates over stale repricer_action
-- estimates on pending orders.
--
-- The code fix is in fetch-live-orders (2026-08-24): repricer_* moved from the
-- TRUSTED source tier to the SOFT tier, so a qualified + owner-matched BB
-- estimate may override it. That only affects orders processed from now on --
-- captureMissingBbEstimateForOrders targets orders MISSING a BB estimate and
-- will not revisit rows that already have one. This is the catch-up for rows
-- already carrying both values.
--
-- No API calls: bb_estimate_price and bb_estimate_qualified are already stored
-- on every affected row.
--
-- ⚠️ THIS IS A TAIL FIX, NOT A BIAS CORRECTION. Measured on the 60 candidate
-- rows before writing anything:
--
--   effectively equal (< $0.01)        49   (82%)
--   differ by more than $2              2
--   worst gap                     $84.01
--   average gap                    $1.54
--
-- That $1.54 average is almost entirely one row -- $84.01 across 60 rows is
-- $1.40 of it -- so the other 59 sit about 14 CENTS apart. The two sources
-- agree nearly always; the point of this is the rare case where the repricer
-- log has gone stale and is wrong by a lot.
--
-- Note also that the BB estimate is HIGHER on average ($30.32 vs $29.16), so
-- there is no systematic overstatement in pending revenue. An early reading of
-- one order suggested otherwise and was wrong.
--
-- WHY quantity > 0
-- ----------------
-- One of the two large-gap rows (702-8488994-1797847, B077ZYJ3TB, 2026-06-26,
-- $544.09 vs $628.10) has quantity = 0. A zero-quantity order has no revenue to
-- estimate, its fundamentals are already wrong, and there is no evidence which
-- of the two prices is correct. Promoting a price onto it would be guessing.
-- Excluded here and worth investigating separately -- a pending zero-quantity
-- order two months old is its own anomaly.
--
-- The other large-gap row, 113-0152910-9077011 (B079STG3DR, 2026-08-23,
-- $32.87 -> $25.94), is the same defect confirmed a second time: sibling order
-- 112-0854205-5253012 on 2026-08-24 carried identical figures and was verified
-- against Amazon Seller Central at $25.94, backed by 28 consecutive own-BB
-- snapshots in the 5.8h before that sale.
--
-- Guards mirror the two existing single-order migrations
-- (20260604171236, 20260702112601): only sold_price = 0, only qualified and
-- owner-matched, and never a row whose price_confidence is already CONFIRMED.

UPDATE public.sales_orders
SET estimated_price   = bb_estimate_price,
    locked_est_price  = bb_estimate_price,
    locked_from       = 'bb_estimate:own_buybox',
    price_source      = 'bb_estimate:own_buybox',
    price_confidence  = 'HIGH_CONFIDENCE_PENDING',
    updated_at        = now()
WHERE sold_price = 0
  AND quantity > 0
  AND bb_estimate_qualified = true
  AND bb_estimate_owner_match = true
  AND bb_estimate_price > 0
  AND price_source LIKE 'seller_derived:repricer%'
  AND price_confidence IS DISTINCT FROM 'CONFIRMED'
  -- No-op rows are excluded rather than rewritten: 49 of 60 agree to the cent,
  -- and touching them would churn updated_at and fire realtime events for no
  -- change.
  AND abs(coalesce(estimated_price, 0) - bb_estimate_price) >= 0.01;
