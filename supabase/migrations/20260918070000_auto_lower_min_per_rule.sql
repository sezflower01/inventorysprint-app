-- Auto-lower min price: per-rule switch, interval and daily drop limit.
--
-- ---- WHY ----------------------------------------------------------------
-- Seller request 2026-09-18: the VA does not check the repricer daily to lower
-- mins, so the automation must carry it -- switched on or off INSIDE each
-- rule, with a check interval the seller picks (5, 10, ... 60 minutes).
--
-- Decided with the seller, from measurement (20260918060000 ... 062000):
--   * the setting lives on the RULE and covers every product in it. The old
--     per-assignment flag was set once when switched on and never for
--     listings added later, so coverage decayed silently;
--   * the "5 drops per listing, ever" limit becomes a PER-DAY limit set in the
--     rule (default 3). At a 5-minute interval five lifetime drops would be
--     spent in 25 minutes and the listing then stuck until a person reset it
--     -- 126 in-stock listings were already stuck on that limit;
--   * US only for now (CA/MX/BR need FX and a 70% policy floor and have never
--     run live).
-- Unchanged safety: never below break-even at the COG, never more than 30% per
-- step, never more than 30% below the anchored starting floor.
--
-- ---- WHAT THIS MIGRATION DOES -------------------------------------------
--   1. repricer_rules: auto_lower_min_marketplaces text[] (where it is on),
--      auto_lower_min_interval_minutes (5..60, multiples of 5),
--      auto_lower_min_max_drops_per_day (1..20), auto_lower_min_last_run_at.
--   2. repricer_assignments: auto_floor_drop_day + auto_floor_drops_on_day,
--      the daily counter (UTC day).
--   3. Carry today's setup over: every rule with auto-lower on for US
--      assignments today gets 'US', interval 60 (= today's hourly run) and 3
--      drops/day. Nothing runs differently until the worker is redeployed.
--   4. Listings already at the old 5-drop limit are marked as having used
--      today's allowance, so they resume TOMORROW (seller chose the daily
--      limit, not an immediate release of the 126).
--   5. latest_competitor_snapshots(): one newest snapshot per ASIN for one
--      seller, via the existing (user_id, asin, marketplace, fetched_at DESC)
--      index. Replaces a single capped read (PostgREST returns at most 1,000
--      rows) that also did not filter by seller.
--   The cron schedule is NOT changed here; that happens only after the new
--   worker is deployed and dry-run checked.

ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS auto_lower_min_marketplaces      text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS auto_lower_min_interval_minutes  smallint    NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS auto_lower_min_max_drops_per_day smallint    NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS auto_lower_min_last_run_at       timestamptz;

DO $c$
BEGIN
  ALTER TABLE public.repricer_rules ADD CONSTRAINT repricer_rules_auto_lower_interval_chk
    CHECK (auto_lower_min_interval_minutes BETWEEN 5 AND 60 AND auto_lower_min_interval_minutes % 5 = 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

DO $c$
BEGIN
  ALTER TABLE public.repricer_rules ADD CONSTRAINT repricer_rules_auto_lower_drops_chk
    CHECK (auto_lower_min_max_drops_per_day BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

COMMENT ON COLUMN public.repricer_rules.auto_lower_min_marketplaces IS
  'Marketplaces where repricer-auto-lower-min may lower mins for EVERY enabled assignment on this rule. Worker runs US only for now.';
COMMENT ON COLUMN public.repricer_rules.auto_lower_min_interval_minutes IS
  'How often (5..60 min, step 5) the worker checks this rule. Competitor data refreshes ~every 19 min per ASIN (measured 2026-09-18), so under ~15 min mostly re-reads the same data.';
COMMENT ON COLUMN public.repricer_rules.auto_lower_min_max_drops_per_day IS
  'Max automatic min drops per assignment per UTC day. Replaced the lifetime 5-drop limit on 2026-09-18.';

ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS auto_floor_drop_day     date,
  ADD COLUMN IF NOT EXISTS auto_floor_drops_on_day smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.repricer_assignments.auto_floor_drops_on_day IS
  'Automatic min drops on auto_floor_drop_day (UTC). The daily allowance is the rule''s auto_lower_min_max_drops_per_day. auto_floor_drop_count stays as a lifetime total, no longer a limit.';

-- Latest snapshot per ASIN for one seller and marketplace.
CREATE OR REPLACE FUNCTION public.latest_competitor_snapshots(
  p_user_id uuid, p_asins text[], p_marketplace text
)
RETURNS TABLE (asin text, lowest_fba_price numeric, lowest_overall_price numeric, buybox_price numeric, fetched_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT a.asin, s.lowest_fba_price, s.lowest_overall_price, s.buybox_price, s.fetched_at
  FROM unnest(p_asins) AS a(asin)
  CROSS JOIN LATERAL (
    SELECT cs.lowest_fba_price, cs.lowest_overall_price, cs.buybox_price, cs.fetched_at
    FROM public.repricer_competitor_snapshots cs
    WHERE cs.user_id = p_user_id AND cs.asin = a.asin AND cs.marketplace = p_marketplace
    ORDER BY cs.fetched_at DESC
    LIMIT 1
  ) s;
$fn$;

REVOKE ALL ON FUNCTION public.latest_competitor_snapshots(uuid, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_competitor_snapshots(uuid, text[], text) TO service_role;

DO $d$
DECLARE r record; v_rules int; v_capped int;
BEGIN
  -- 3. carry over today's setup
  WITH on_rules AS (
    SELECT DISTINCT a.rule_id
    FROM public.repricer_assignments a
    WHERE a.auto_lower_min_price AND a.is_enabled AND a.status = 'active'
      AND a.marketplace = 'US' AND a.rule_id IS NOT NULL
  )
  UPDATE public.repricer_rules ru
     SET auto_lower_min_marketplaces = ARRAY['US'],
         auto_lower_min_interval_minutes = 60,
         auto_lower_min_max_drops_per_day = 3
   WHERE ru.id IN (SELECT rule_id FROM on_rules)
     AND NOT ('US' = ANY (ru.auto_lower_min_marketplaces));
  GET DIAGNOSTICS v_rules = ROW_COUNT;
  RAISE NOTICE 'rules switched on for US (interval 60, 3/day): %', v_rules;

  -- 4. listings at the old lifetime limit resume tomorrow
  UPDATE public.repricer_assignments a
     SET auto_floor_drop_day = (now() AT TIME ZONE 'UTC')::date,
         auto_floor_drops_on_day = 20
   WHERE a.marketplace = 'US' AND COALESCE(a.auto_floor_drop_count, 0) >= 5
     AND a.is_enabled AND a.status = 'active';
  GET DIAGNOSTICS v_capped = ROW_COUNT;
  RAISE NOTICE 'listings at the old 5-drop limit, paused until tomorrow (UTC): %', v_capped;

  FOR r IN SELECT ru.name, ru.auto_lower_min_marketplaces AS mk, ru.auto_lower_min_interval_minutes AS iv, ru.auto_lower_min_max_drops_per_day AS md,
                  (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = ru.id AND a.is_enabled AND a.status = 'active' AND a.marketplace = 'US') AS us_active,
                  (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = ru.id AND a.is_enabled AND a.status = 'active' AND a.marketplace = 'US' AND a.auto_lower_min_price) AS flagged
           FROM public.repricer_rules ru WHERE array_length(ru.auto_lower_min_marketplaces, 1) > 0 LOOP
    RAISE NOTICE '  rule "%" on in % | every % min | %/day | US active % (previously flagged %)', r.name, r.mk, r.iv, r.md, r.us_active, r.flagged;
  END LOOP;
END
$d$;
