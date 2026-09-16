-- COG on record for the repricer: one definition of a COG the repricer may
-- trust, and flag the placeholder COGs for review.
--
-- ---- WHY ----------------------------------------------------------------
--
-- The seller asked (2026-09-16) for the repricer to read COG on record the
-- same way Inventory Valuation does. Measured first (20260916010000 ..
-- 20260916014000):
--
--   * Cost moves live prices in repricer-auto-lower-min, the hourly cron that
--     lowers min prices but never below the ROI floor computed from cost (US
--     policy floor = break-even). It reads inventory.cost, which is empty on
--     233 of its 650 US rows (skipped as no_cost) and garbage on some others:
--     B09R8YZX39 at $237.49 (a lot total; COG $5.94), B07VXRVZHH at $0.11.
--   * 119 COGs are under $2 -- 104 exactly $1.00 -- all unreviewed imports.
--     The import dropped lots under $0.10/unit and averages under $0.50, but
--     $1.00 placeholder lots slipped through. 65 sit on auto-lower rows, e.g.
--     B0725P2SY3: $50.99 min, $1.00 COG. Trusting them would let the worker
--     treat break-even as ~$5-7 and cut those floors ~30% per run.
--
-- Decided with the seller:
--   * the repricer treats an unreviewed COG under $2 as NO cost (rows keep
--     being skipped exactly as today), and all 119 are flagged "Needs review"
--     on the COG page; once the seller sets or confirms one, it is used;
--   * rows skipped today only for lack of inventory.cost DO start using COG.
--
-- ---- THE RULE -----------------------------------------------------------
--
-- A COG is usable by the repricer when unit_cost > 0, it is not flagged
-- needs_review, and it is not (under $2 AND never reviewed AND not typed by
-- the seller). Kept in ONE view so every repricer path -- edge functions and
-- the Repricer page -- applies the same rule. security_invoker so the page's
-- RLS still scopes it to the signed-in seller.
--
-- Flagging touches needs_review/review_note only. The sales re-pricing trigger
-- (cog_on_record_after_change) fires on UPDATE OF unit_cost, so no 2026 sale
-- is rewritten by this migration.

CREATE OR REPLACE VIEW public.asin_cog_for_repricer
WITH (security_invoker = true) AS
SELECT c.user_id, c.asin, c.unit_cost, c.source, c.reviewed_at, c.updated_at
FROM public.asin_cog_on_record c
WHERE c.unit_cost > 0
  AND NOT COALESCE(c.needs_review, false)
  AND NOT (c.unit_cost < 2 AND c.reviewed_at IS NULL AND c.source <> 'manual');

COMMENT ON VIEW public.asin_cog_for_repricer IS
  'COG on record rows the repricer may use as unit cost. Excludes rows flagged needs_review and unreviewed, non-manual COGs under $2 (placeholder $1.00 lots). Precedence in every repricer path: asin_cost_overrides -> this view -> the path''s previous source. See 20260916020000.';

GRANT SELECT ON public.asin_cog_for_repricer TO authenticated, service_role;

DO $flag$
DECLARE v_n int;
BEGIN
  UPDATE public.asin_cog_on_record c
     SET needs_review = true,
         review_note = format(
           'Placeholder-looking COG (%s) from purchase history -- the repricer ignores it until you set the real cost or confirm this one.',
           to_char(c.unit_cost, 'FM$990.00'))
   WHERE c.unit_cost > 0
     AND c.unit_cost < 2
     AND c.reviewed_at IS NULL
     AND c.source <> 'manual'
     AND NOT COALESCE(c.needs_review, false);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'flagged for review: % COGs (expected 119)', v_n;

  SELECT count(*) INTO v_n FROM public.asin_cog_for_repricer;
  RAISE NOTICE 'COGs usable by the repricer: %', v_n;
END
$flag$;
