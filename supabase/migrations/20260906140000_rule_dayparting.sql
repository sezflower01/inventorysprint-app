-- Dayparting: a daily time window where a rule undercuts instead of matching.
--
-- ---- WHY -----------------------------------------------------------------
--
-- The seller observes that sales come in the morning and slow after midday,
-- and wants to be more aggressive during the busy hours only. Momentum Smart
-- currently matches (undercut_amount = 0). Inside the window it should go a
-- set amount under the same competitor instead.
--
-- ---- WHAT IT DELIBERATELY DOES NOT TOUCH ---------------------------------
--
-- Only the undercut AMOUNT changes. The anchor (target_anchor) and the
-- competitor set (fbm_competition_mode) are untouched, so inside the window
-- the rule aims at exactly the same offer it aims at now -- it just lands a
-- little under it. That keeps the change predictable: one number moves, and
-- outside the window nothing at all is different.
--
-- ---- THE FLOOR IS NOT NEGOTIABLE -----------------------------------------
--
-- Confirmed with the seller 2026-09-06: the daypart undercut must NEVER push
-- a price below min_price. There is no column here to permit it, on purpose --
-- an option that dangerous should not exist as a checkbox on 254 ASINs. The
-- existing floor logic already clamps; this feature adds nothing that can
-- bypass it.
--
-- ---- TIMES ARE DATA, NOT CODE --------------------------------------------
--
-- Stored per rule and edited in the rule form, so the hours can change without
-- a deploy. Per-rule rather than per-account so one rule can run a window
-- while others do not.

ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS daypart_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS daypart_start text,
  ADD COLUMN IF NOT EXISTS daypart_end text,
  ADD COLUMN IF NOT EXISTS daypart_undercut_amount numeric;

COMMENT ON COLUMN public.repricer_rules.daypart_enabled IS
  'When true and the local clock is inside [daypart_start, daypart_end), daypart_undercut_amount replaces undercut_amount for this rule. Never bypasses min_price.';
COMMENT ON COLUMN public.repricer_rules.daypart_start IS
  'HH:MM, 24h, in the account''s repricer_settings.schedule_timezone. Inclusive.';
COMMENT ON COLUMN public.repricer_rules.daypart_end IS
  'HH:MM, 24h, same timezone. Exclusive, so 06:00-12:00 stops at 11:59. A window where end < start crosses midnight.';
COMMENT ON COLUMN public.repricer_rules.daypart_undercut_amount IS
  'Dollars below the anchor during the window. 0.01 turns a matching rule into a one-cent undercut.';

-- Guard the shape at write time. A malformed "6:00" or "25:00" would otherwise
-- fail silently at evaluation, which on a pricing rule means quietly doing
-- nothing rather than erroring where someone would see it.
ALTER TABLE public.repricer_rules
  DROP CONSTRAINT IF EXISTS repricer_rules_daypart_times_valid;
ALTER TABLE public.repricer_rules
  ADD CONSTRAINT repricer_rules_daypart_times_valid CHECK (
    (daypart_start IS NULL OR daypart_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND (daypart_end IS NULL OR daypart_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND (daypart_undercut_amount IS NULL OR daypart_undercut_amount >= 0)
  );

-- Enabling the window without the values that make it mean anything would be
-- an invisible no-op, so require them together.
ALTER TABLE public.repricer_rules
  DROP CONSTRAINT IF EXISTS repricer_rules_daypart_complete;
ALTER TABLE public.repricer_rules
  ADD CONSTRAINT repricer_rules_daypart_complete CHECK (
    daypart_enabled = false
    OR (daypart_start IS NOT NULL AND daypart_end IS NOT NULL
        AND daypart_undercut_amount IS NOT NULL AND daypart_start <> daypart_end)
  );

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT count(*) AS rules,
           count(*) FILTER (WHERE daypart_enabled) AS with_daypart
    FROM public.repricer_rules
  LOOP
    RAISE NOTICE 'repricer_rules: % rules, % with dayparting enabled (expect 0 -- off by default)',
      r.rules, r.with_daypart;
  END LOOP;
END $$;
