-- Auto-lower min: per-rule "beat" anchor (seller request 2026-09-18:
-- "0.01 less than the lowest or BB owner").
--   'lowest'  -> target = lowest competitor price - undercut (previous behaviour)
--   'buybox'  -> target = Buy Box price           - undercut
-- If a product has no Buy Box price in its latest snapshot, the worker falls
-- back to the lowest price and records that it did. All safety limits apply.

ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS auto_lower_min_anchor text NOT NULL DEFAULT 'lowest';

DO $c$
BEGIN
  ALTER TABLE public.repricer_rules ADD CONSTRAINT repricer_rules_auto_lower_anchor_chk
    CHECK (auto_lower_min_anchor IN ('lowest', 'buybox'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

COMMENT ON COLUMN public.repricer_rules.auto_lower_min_anchor IS
  'Auto-lower min aims auto_lower_min_undercut below this price: lowest (competitor) or buybox. Falls back to lowest when no Buy Box price is known.';
