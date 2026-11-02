-- STEP 2: auto-average the COG when a shipment is accepted by Amazon.
--
-- ── WHY THIS MOMENT ──────────────────────────────────────────────────
--
-- A purchase typed into the app is not evidence of anything -- the seller
-- sometimes enters one and never buys it. A draft save is not evidence either,
-- because a draft is still editable. The first point at which the units are
-- committed is when the inbound plan is accepted by Amazon: the draft gains an
-- inbound_plan_id and continued_to_amazon_at, and its status becomes
-- 'continued'. That is the trusted document, and it is already recorded.
--
-- Measured 2026-11-02 before building this: 98 of 126 drafts are 'continued'
-- and all 98 carry both inbound_plan_id and continued_to_amazon_at, covering
-- 568 purchase lots and 42.9 pct of this year's spend. By contrast
-- amazon_shipment_id was set on 1 draft, units_shipped on 190 lots, and no
-- draft ever reaches status 'completed' -- so none of those could be the gate.
--
-- ── IDEMPOTENCY, which is the whole risk ─────────────────────────────
--
-- A draft can be re-saved, edited and resubmitted, or flip to 'continued' more
-- than once. If a lot were counted twice the average would be wrong and there
-- would be no way to tell from the result. So confirmation is stored once per
-- PURCHASE LOT in cog_purchase_confirmations, whose primary key IS the lot id.
-- The first shipment that carries a lot owns it; every later attempt is an
-- ON CONFLICT DO NOTHING no-op. Idempotency is therefore a property of the
-- schema, not of the code path.
--
-- ── PARTIAL LOTS ─────────────────────────────────────────────────────
--
-- created_listings.cost is a LINE TOTAL for the whole lot (the cost-contract
-- inversion -- cost is per-unit on inventory and a total here). So a lot that
-- ships partially contributes a PROPORTION of its cost:
--     spent = cost * confirmed_units / units
-- Units confirmed are units_shipped when the builder recorded them, otherwise
-- units_allocated. That fallback matters in practice: units_shipped is
-- populated on only 190 of 624 allocated lots, so most confirmations will use
-- the allocated figure. Which one was used is stored per row so the number can
-- always be explained.
--
-- ── WHAT IT MUST NOT DO ──────────────────────────────────────────────
--
-- resolve_unit_cost_v1 puts asin_cost_overrides first, so a hand-set cost wins
-- over everything. This must never overwrite one: an ASIN with an override is
-- skipped entirely and the skip is counted. Same for an ASIN whose COG was
-- last set to source='manual' -- the seller's own figure stands.

-- ── 1. allow the new source label ────────────────────────────────────
ALTER TABLE public.asin_cog_on_record
  DROP CONSTRAINT IF EXISTS asin_cog_on_record_source_check;
ALTER TABLE public.asin_cog_on_record
  ADD CONSTRAINT asin_cog_on_record_source_check
  -- 'listing' was already live (96 rows) -- the constraint had been widened
  -- past the original migration's ('import','manual') and my first attempt was
  -- rejected by the data. Checked rather than assumed the second time.
  CHECK (source IN ('import', 'manual', 'listing', 'auto_shipment'));

COMMENT ON CONSTRAINT asin_cog_on_record_source_check ON public.asin_cog_on_record IS
  'auto_shipment added 2026-11-02: the COG was computed from purchase lots confirmed by an accepted FBA inbound plan. The shipment id is in calculation->>''shipment_id''. manual always wins over auto_shipment; import and listing are fallbacks and may be replaced by it.';

-- ── 2. the confirmation ledger ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cog_purchase_confirmations (
  -- The PK is the purchase lot, which is what makes this idempotent.
  created_listing_id UUID PRIMARY KEY
    REFERENCES public.created_listings(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin               TEXT NOT NULL,
  draft_id           TEXT NOT NULL,
  shipment_id        TEXT,
  inbound_plan_id    TEXT,
  units_confirmed    INTEGER NOT NULL CHECK (units_confirmed > 0),
  units_source       TEXT NOT NULL CHECK (units_source IN ('units_shipped','units_allocated')),
  confirmed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cog_conf_user_asin
  ON public.cog_purchase_confirmations (user_id, asin);

ALTER TABLE public.cog_purchase_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cog_purchase_confirmations FROM PUBLIC, anon;
DROP POLICY IF EXISTS cog_conf_select_own ON public.cog_purchase_confirmations;
CREATE POLICY cog_conf_select_own ON public.cog_purchase_confirmations
  FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

COMMENT ON TABLE public.cog_purchase_confirmations IS
  'One row per purchase lot whose units were accepted by Amazon in an FBA inbound plan. The primary key is the lot, so a lot can be confirmed only once however many times a draft is resubmitted. Written only by confirm_shipment_purchases().';

-- ── 3. recompute one ASIN's average from confirmed lots ──────────────
CREATE OR REPLACE FUNCTION public.recompute_cog_from_confirmed(
  p_user_id uuid,
  p_asin    text,
  p_shipment_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_spent numeric; v_units numeric; v_lots int; v_avg numeric;
  v_existing_source text; v_has_override boolean;
BEGIN
  -- A hand-set override outranks everything downstream, so never touch it.
  SELECT EXISTS (SELECT 1 FROM public.asin_cost_overrides o
                  WHERE o.user_id = p_user_id AND o.asin = p_asin)
    INTO v_has_override;
  IF v_has_override THEN
    RETURN jsonb_build_object('asin', p_asin, 'skipped', 'manual_override_exists');
  END IF;

  -- The seller's own COG also wins. auto_shipment may create or update an
  -- auto/import row, never replace a manual one.
  SELECT source INTO v_existing_source
  FROM public.asin_cog_on_record
  WHERE user_id = p_user_id AND asin = p_asin;
  IF v_existing_source = 'manual' THEN
    RETURN jsonb_build_object('asin', p_asin, 'skipped', 'manual_cog_on_record');
  END IF;

  -- Proportional cost: created_listings.cost is the LINE TOTAL for `units`.
  SELECT sum(cl.cost * c.units_confirmed::numeric / NULLIF(cl.units,0)),
         sum(c.units_confirmed),
         count(*)
    INTO v_spent, v_units, v_lots
  FROM public.cog_purchase_confirmations c
  JOIN public.created_listings cl ON cl.id = c.created_listing_id
  WHERE c.user_id = p_user_id AND c.asin = p_asin
    AND cl.cost > 0 AND cl.units > 0;

  IF COALESCE(v_units,0) <= 0 THEN
    RETURN jsonb_build_object('asin', p_asin, 'skipped', 'no_confirmed_units');
  END IF;

  v_avg := round(v_spent / v_units, 4);

  INSERT INTO public.asin_cog_on_record
    (user_id, asin, unit_cost, source, calculated_cost, calculation)
  VALUES (p_user_id, p_asin, v_avg, 'auto_shipment', v_avg,
          jsonb_build_object('spent', round(v_spent,2), 'units', v_units,
                             'lots', v_lots, 'shipment_id', p_shipment_id,
                             'computed_at', now()))
  ON CONFLICT (user_id, asin) DO UPDATE
    SET unit_cost = EXCLUDED.unit_cost,
        source = 'auto_shipment',
        calculated_cost = EXCLUDED.calculated_cost,
        calculation = EXCLUDED.calculation,
        updated_at = now()
    WHERE public.asin_cog_on_record.source <> 'manual';

  RETURN jsonb_build_object('asin', p_asin, 'unit_cost', v_avg,
                            'units', v_units, 'lots', v_lots);
END
$fn$;

REVOKE ALL ON FUNCTION public.recompute_cog_from_confirmed(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recompute_cog_from_confirmed(uuid, text, text) TO service_role;

-- ── 4. confirm every lot in a draft, then recompute its ASINs ────────
CREATE OR REPLACE FUNCTION public.confirm_shipment_purchases(
  p_user_id uuid,
  p_draft_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ship text; v_plan text; v_new int := 0; v_asins int := 0;
  v_results jsonb := '[]'::jsonb; r record;
BEGIN
  SELECT amazon_shipment_id, inbound_plan_id INTO v_ship, v_plan
  FROM public.shipment_builder_drafts
  WHERE user_id = p_user_id AND draft_id = p_draft_id;

  -- ON CONFLICT DO NOTHING is the idempotency guarantee: the PK is the lot.
  WITH ins AS (
    INSERT INTO public.cog_purchase_confirmations
      (created_listing_id, user_id, asin, draft_id, shipment_id,
       inbound_plan_id, units_confirmed, units_source)
    SELECT a.created_listing_id, a.user_id, a.asin, a.draft_id,
           COALESCE(a.shipment_id, v_ship), v_plan,
           CASE WHEN a.units_shipped > 0 THEN a.units_shipped
                ELSE a.units_allocated END,
           CASE WHEN a.units_shipped > 0 THEN 'units_shipped'
                ELSE 'units_allocated' END
    FROM public.shipment_purchase_allocations a
    JOIN public.created_listings cl ON cl.id = a.created_listing_id
    WHERE a.user_id = p_user_id AND a.draft_id = p_draft_id
      AND GREATEST(a.units_shipped, a.units_allocated) > 0
      AND cl.cost > 0 AND cl.units > 0
    ON CONFLICT (created_listing_id) DO NOTHING
    RETURNING asin)
  SELECT count(*) INTO v_new FROM ins;

  -- Recompute every ASIN this draft touched, whether or not a lot was new:
  -- a second shipment of the SAME asin with a different lot still moves the
  -- average, and recomputing is cheap and idempotent.
  FOR r IN
    SELECT DISTINCT a.asin FROM public.shipment_purchase_allocations a
    WHERE a.user_id = p_user_id AND a.draft_id = p_draft_id
  LOOP
    v_asins := v_asins + 1;
    v_results := v_results || public.recompute_cog_from_confirmed(p_user_id, r.asin, v_ship);
  END LOOP;

  RETURN jsonb_build_object('draft_id', p_draft_id, 'shipment_id', v_ship,
                            'inbound_plan_id', v_plan,
                            'lots_newly_confirmed', v_new,
                            'asins_recomputed', v_asins,
                            'results', v_results);
END
$fn$;

REVOKE ALL ON FUNCTION public.confirm_shipment_purchases(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_shipment_purchases(uuid, text) TO service_role;

-- ── 5. fire it when the draft is accepted by Amazon ──────────────────
CREATE OR REPLACE FUNCTION public.zz_cog_on_draft_continued()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  -- Only on the TRANSITION into accepted-by-Amazon. Re-saving a draft that is
  -- already continued must not re-fire, and the lot-level PK would stop a
  -- double count anyway -- belt and braces, because the average is money.
  IF (NEW.continued_to_amazon_at IS NOT NULL
      AND OLD.continued_to_amazon_at IS NULL)
     OR (NEW.status IN ('continued','synced','completed')
         AND COALESCE(OLD.status,'') NOT IN ('continued','synced','completed'))
  THEN
    PERFORM public.confirm_shipment_purchases(NEW.user_id, NEW.draft_id);
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS zz_cog_on_draft_continued ON public.shipment_builder_drafts;
CREATE TRIGGER zz_cog_on_draft_continued
  AFTER UPDATE ON public.shipment_builder_drafts
  FOR EACH ROW EXECUTE FUNCTION public.zz_cog_on_draft_continued();

COMMENT ON FUNCTION public.zz_cog_on_draft_continued() IS
  'Fires once when a shipment draft is accepted by Amazon, confirming its purchase lots and recomputing those ASINs COG from confirmed lots only. Named zz_ so it runs after other triggers on this table.';

-- ── 6. report, without firing anything ───────────────────────────────
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== installed ==';
  RAISE NOTICE '   cog_purchase_confirmations rows: %',
    (SELECT count(*) FROM public.cog_purchase_confirmations);
  RAISE NOTICE '   NOTE: no backfill. The trigger fires on FUTURE transitions';
  RAISE NOTICE '   only, so nothing has changed yet and no COG moved.';
  RAISE NOTICE '';
  RAISE NOTICE '   what a backfill WOULD confirm, if asked for:';
  FOR r IN
    SELECT count(DISTINCT a.created_listing_id) AS lots,
           count(DISTINCT a.asin) AS asins,
           count(DISTINCT a.draft_id) AS drafts
    FROM public.shipment_purchase_allocations a
    JOIN public.shipment_builder_drafts d
      ON d.user_id = a.user_id AND d.draft_id = a.draft_id
    JOIN public.created_listings cl ON cl.id = a.created_listing_id
    WHERE a.user_id = v_uid
      AND d.continued_to_amazon_at IS NOT NULL
      AND GREATEST(a.units_shipped, a.units_allocated) > 0
      AND cl.cost > 0 AND cl.units > 0
  LOOP
    RAISE NOTICE '      % lots across % ASINs from % accepted drafts',
      r.lots, r.asins, r.drafts;
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '   asin_cost_overrides on file (never overwritten): %',
    (SELECT count(DISTINCT asin) FROM public.asin_cost_overrides WHERE user_id = v_uid);
  RAISE NOTICE '   asin_cog_on_record with source=manual (also protected): %',
    (SELECT count(*) FROM public.asin_cog_on_record
      WHERE user_id = v_uid AND source = 'manual');
END
$p$;
