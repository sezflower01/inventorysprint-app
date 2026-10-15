-- Audit + backup for the manual "recheck Keepa" button on non-US records.
--
-- Every apply writes one row here BEFORE touching sales_orders, so a wrong
-- estimate can always be traced and reverted. This is a user-initiated
-- override, so it has to be recoverable per order, not just per batch.
--
-- Why the button exists at all. Measured 2026-10-14 over 928 settled CA
-- orders, mean ABSOLUTE error of each way of estimating a pending price:
--
--   listings_api (what runs today)   476 covered   28.1 pct   bias -26.0 pct
--   Keepa buybox nearest the order   340 covered   14.4 pct   bias  +6.6 pct
--   last settled price, same ASIN    745 covered   10.0 pct   bias  +2.9 pct
--
-- On the 340 orders Keepa covers it is 14.4 pct against listings_api's 26.2
-- pct on those SAME orders -- roughly twice as accurate, which is why a
-- manual recheck is worth having. It is NOT the best available estimate
-- though: last-settled-price wins on both accuracy and coverage, and Keepa
-- adds only 45 orders that last-settled does not already cover. So this
-- stays a deliberate, per-record button rather than becoming the automatic
-- path.
--
-- Known limits, all measured the same day:
--   - the non-US cache is almost entirely expired (CA 1 of 125 rows
--     unexpired, MX 0 of 103, BR 0 of 90), so a press nearly always spends
--     Keepa tokens rather than reading cache
--   - the buybox point is "price now", not price at purchase time
--   - coverage is 37 pct of settled CA orders; of the orders that need an
--     estimate right now, CA 3 of 9, MX 1 of 9, BR 0 of 1

CREATE TABLE IF NOT EXISTS public.keepa_estimate_recheck_log (
  id              bigserial PRIMARY KEY,
  user_id         uuid        NOT NULL,
  order_id        text        NOT NULL,
  asin            text        NOT NULL,
  marketplace     text        NOT NULL,
  -- NATIVE marketplace currency, both of them: estimated_price is contracted
  -- native for non-US and Keepa returns native, so no conversion is involved
  -- and none must be introduced here.
  old_estimate    numeric,
  new_estimate    numeric,
  old_price_source text,
  old_locked_from  text,
  keepa_track     text,        -- buybox | newFba | newFbm
  keepa_point_at  timestamptz, -- when Keepa captured that price
  applied_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.keepa_estimate_recheck_log IS
  'Pre-change backup and audit trail for the manual non-US "Recheck Keepa" button. One row per order per apply, written before sales_orders is updated. old_estimate/new_estimate are NATIVE marketplace currency.';

CREATE INDEX IF NOT EXISTS keepa_estimate_recheck_log_order_idx
  ON public.keepa_estimate_recheck_log (user_id, order_id, applied_at DESC);

ALTER TABLE public.keepa_estimate_recheck_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own recheck log" ON public.keepa_estimate_recheck_log;
CREATE POLICY "own recheck log" ON public.keepa_estimate_recheck_log
  FOR SELECT USING (auth.uid() = user_id);
