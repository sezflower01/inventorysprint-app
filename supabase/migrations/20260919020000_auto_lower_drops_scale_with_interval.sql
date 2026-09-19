-- Auto-lower min: max drops per day now scales with the check interval.
--
-- Seller request (2026-09-19): a rule checking every 60 min gets 12 drops a
-- day, and a shorter interval gets proportionally more, so the allowance
-- keeps pace with how often the rule looks. Formula: round(720 / interval),
-- i.e. up to one drop per two checks:
--   5 -> 144 | 10 -> 72 | 15 -> 48 | 20 -> 36 | 25 -> 29 | 30 -> 24
--   35 -> 21 | 40 -> 18 | 45 -> 16 | 50 -> 14 | 55 -> 13 | 60 -> 12
-- The UI fills this in whenever the interval changes and still lets the
-- seller override it. The old 1..20 cap would reject everything under 40 min,
-- so the cap becomes 288 (one drop per check at 5 min -- the most a listing
-- can physically get, since each run lowers a listing at most once).
-- The per-drop and cumulative 30% limits and the ROI floor are unchanged and
-- still bound how far a price can actually fall in a day.

ALTER TABLE public.repricer_rules DROP CONSTRAINT IF EXISTS repricer_rules_auto_lower_drops_chk;
ALTER TABLE public.repricer_rules ADD CONSTRAINT repricer_rules_auto_lower_drops_chk
  CHECK (auto_lower_min_max_drops_per_day BETWEEN 1 AND 288);

UPDATE public.repricer_rules
SET auto_lower_min_max_drops_per_day = round(720.0 / auto_lower_min_interval_minutes)
WHERE auto_lower_min_max_drops_per_day IS DISTINCT FROM round(720.0 / auto_lower_min_interval_minutes);

COMMENT ON COLUMN public.repricer_rules.auto_lower_min_max_drops_per_day IS
  'Max automatic min drops per assignment per UTC day (1..288). Defaults to round(720 / interval) -- 12 per 60 min -- set by the UI when the interval changes, overridable. Replaced the lifetime 5-drop limit on 2026-09-18.';

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT name, auto_lower_min_marketplaces AS mk, auto_lower_min_interval_minutes AS iv, auto_lower_min_max_drops_per_day AS md
           FROM public.repricer_rules WHERE cardinality(auto_lower_min_marketplaces) > 0 ORDER BY name LOOP
    RAISE NOTICE 'rule % (%): every % min -> % drops/day', r.name, r.mk, r.iv, r.md;
  END LOOP;
END
$p$;
