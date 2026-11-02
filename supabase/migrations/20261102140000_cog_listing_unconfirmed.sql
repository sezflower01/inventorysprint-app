-- A COG filled from an UNSHIPPED purchase is labelled unconfirmed.
--
-- ── THE PROBLEM, IN THE SELLER'S WORDS ───────────────────────────────
--
-- "Sometimes I add a purchase and forget to buy." Today
-- cog_on_record_from_listing fires AFTER INSERT on created_listings and, for a
-- brand-new product, writes a COG straight from that single lot with
-- source='listing'. So an unbought purchase sets a real cost immediately, and
-- every 2026 sale of that ASIN is priced from it by the write-through trigger.
--
-- ── WHY NOT SIMPLY REFUSE TO WRITE ───────────────────────────────────
--
-- Because 23.5 pct of 2026 COGS -- 110,131.80 of 467,873.75 -- sits on ASINs
-- with no shipment confirmation at all (305 of 635 purchased ASINs, FBM-only
-- or not yet sent). Withholding a cost from them would delete a quarter of
-- COGS and overstate profit by the same. So the cost is still written; what
-- changes is that it is LABELLED, so it can be told apart and excluded.
--
-- ── THE LABEL ────────────────────────────────────────────────────────
--
--   listing_unconfirmed  filled from a lot with no shipment confirmation.
--                        A placeholder: usable as a cost, never evidence.
--   listing              filled from a lot that IS shipment-confirmed.
--   auto_shipment        computed from confirmed lots by
--                        recompute_cog_from_confirmed. Supersedes both.
--   manual               the seller's own. Supersedes everything.
--
-- "Never counts toward confirmed averages" is already guaranteed by
-- construction, not by this label: a confirmed average is computed only from
-- cog_purchase_confirmations, which contains confirmed lots and nothing else.
-- An unconfirmed listing cost has no route into it. The label exists so the
-- page, the seller and any later report can SEE which costs are provisional.
--
-- NO EXISTING COG IS CHANGED. The 96 rows already at source='listing' keep
-- that value; only writes from here on are labelled.

ALTER TABLE public.asin_cog_on_record
  DROP CONSTRAINT IF EXISTS asin_cog_on_record_source_check;
ALTER TABLE public.asin_cog_on_record
  ADD CONSTRAINT asin_cog_on_record_source_check
  CHECK (source IN ('import', 'manual', 'listing', 'listing_unconfirmed', 'auto_shipment'));

CREATE OR REPLACE FUNCTION public.cog_on_record_from_listing(p_listing_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  l      public.created_listings%ROWTYPE;
  c      public.asin_cog_on_record%ROWTYPE;
  v_unit NUMERIC;
  v_src  TEXT;
BEGIN
  SELECT * INTO l FROM public.created_listings WHERE id = p_listing_id;
  IF NOT FOUND THEN RETURN 'skipped: listing not found'; END IF;
  IF l.asin IS NULL OR l.asin !~ '^[A-Z0-9]{10}$' THEN RETURN 'skipped: no valid ASIN'; END IF;
  IF NOT public.is_active_created_listing(l.validation_status) THEN RETURN 'skipped: listing not active'; END IF;

  IF COALESCE(l.cost, 0) <= 0 OR COALESCE(l.units, 0) <= 0 THEN
    RETURN 'skipped: no cost on the listing';
  END IF;
  IF l.units > 1 AND l.amount IS NOT NULL AND abs(l.cost - l.amount) < 0.005 THEN
    RETURN 'skipped: unit price typed into the lot-total field';
  END IF;
  v_unit := round((l.cost / l.units)::numeric, 2);
  IF v_unit < 0.10 THEN
    RETURN 'skipped: placeholder cost under $0.10/unit';
  END IF;

  -- THE NEW PART: is this lot backed by a shipment Amazon accepted?
  v_src := CASE
    WHEN EXISTS (
      SELECT 1 FROM public.cog_purchase_confirmations cc
      WHERE cc.created_listing_id = l.id
    ) OR EXISTS (
      SELECT 1 FROM public.shipment_purchase_allocations a
       JOIN public.shipment_builder_drafts d
         ON d.user_id = a.user_id AND d.draft_id = a.draft_id
      WHERE a.created_listing_id = l.id
        AND d.continued_to_amazon_at IS NOT NULL
    ) THEN 'listing'
    ELSE 'listing_unconfirmed'
  END;

  SELECT * INTO c FROM public.asin_cog_on_record WHERE user_id = l.user_id AND asin = l.asin;

  -- Brand-new product: fill it, labelled.
  IF NOT FOUND THEN
    INSERT INTO public.asin_cog_on_record
      (user_id, asin, unit_cost, source, title, calculated_cost, calculation)
    VALUES (l.user_id, l.asin, v_unit, v_src, l.title, v_unit,
            jsonb_build_object(
              'rule', 'auto from listing (20261102140000)',
              'listing_id', l.id,
              'lot_total', l.cost,
              'units', l.units,
              'shipment_confirmed', (v_src = 'listing'),
              'listing_date', COALESCE(l.date_created::date, l.created_at::date)))
    ON CONFLICT (user_id, asin) DO NOTHING;
    RETURN 'created: ' || v_src;
  END IF;

  -- A row with no cost: fill it, unless set aside for the seller.
  IF c.unit_cost IS NULL THEN
    IF c.needs_review THEN RETURN 'skipped: product is flagged for manual review'; END IF;
    UPDATE public.asin_cog_on_record
       SET unit_cost = v_unit, source = v_src, reviewed_at = NULL, calculated_cost = v_unit,
           calculation = jsonb_build_object('rule', 'auto from listing (20261102140000)',
                                            'listing_id', l.id,
                                            'lot_total', l.cost, 'units', l.units,
                                            'shipment_confirmed', (v_src = 'listing'),
                                            'listing_date', COALESCE(l.date_created::date, l.created_at::date))
     WHERE id = c.id;
    RETURN 'created: ' || v_src;
  END IF;

  -- An auto_shipment or manual COG outranks anything a bare listing can say.
  IF c.source IN ('auto_shipment', 'manual') THEN
    RETURN 'skipped: COG is ' || c.source;
  END IF;

  -- The listing that created this still-unreviewed COG was corrected: follow it,
  -- keeping the label current (a lot can become confirmed later).
  IF c.source IN ('listing','listing_unconfirmed') AND c.reviewed_at IS NULL
     AND c.calculation ->> 'listing_id' = l.id::text THEN
    UPDATE public.asin_cog_on_record
       SET unit_cost = v_unit, source = v_src, calculated_cost = v_unit,
           calculation = c.calculation
             || jsonb_build_object('lot_total', l.cost, 'units', l.units,
                                   'shipment_confirmed', (v_src = 'listing'),
                                   'rule', 'auto from listing (20261102140000)')
     WHERE id = c.id;
    RETURN 'updated: ' || v_src;
  END IF;

  RETURN 'skipped: COG already set';
END
$fn$;

REVOKE ALL ON FUNCTION public.cog_on_record_from_listing(UUID) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.cog_on_record_from_listing(UUID) IS
  'Fills a COG from a purchase lot. Labels it listing_unconfirmed when the lot has no accepted FBA shipment behind it, listing when it does. Never touches a manual or auto_shipment COG. Existing rows are not relabelled.';

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== source values now on file (unchanged by this migration) ==';
  FOR r IN SELECT COALESCE(source,'(null)') AS s, count(*) AS n
           FROM public.asin_cog_on_record GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '   % | %', rpad(r.s,22), r.n; END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '   listing_unconfirmed is allowed from now on and will appear';
  RAISE NOTICE '   only on NEW writes. No existing COG was relabelled.';
END
$p$;
