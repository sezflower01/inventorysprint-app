-- Auto-lower min: per-rule "lower by" amount (seller request 2026-09-18).
--
-- The worker aims the new min this far below the lowest competitor
-- (target = lowest - undercut). It was a hard-coded $0.01; the seller asked
-- for it in each rule, default $0.01. Every safety limit still applies on top:
-- never below break-even at the COG, max 30% per step, max 30% below the
-- anchored starting floor, max drops per day.

ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS auto_lower_min_undercut numeric(6,2) NOT NULL DEFAULT 0.01;

DO $c$
BEGIN
  ALTER TABLE public.repricer_rules ADD CONSTRAINT repricer_rules_auto_lower_undercut_chk
    CHECK (auto_lower_min_undercut >= 0 AND auto_lower_min_undercut <= 10);
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

COMMENT ON COLUMN public.repricer_rules.auto_lower_min_undercut IS
  'Auto-lower min aims this far below the lowest competitor ($, default 0.01; 0 = match). Bounded by break-even, the 30% caps and the daily drop limit.';
