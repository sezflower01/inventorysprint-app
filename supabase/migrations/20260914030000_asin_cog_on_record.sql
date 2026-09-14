-- COG on record: one average unit cost per ASIN, owned and edited by the
-- seller. Created, and loaded once from purchase history.
--
-- ---- WHY ----------------------------------------------------------------
--
-- The seller's original design, stated 2026-09-14: like InventoryLab, keep a
-- single average COG per product and let COGS read it, rather than deriving
-- cost from each Created Listings lot (total / units) and freezing it on the
-- sale. Created Listings cost stays as purchase history, for reference.
--
-- Decided with the seller:
--   * per ASIN -- the FBA and FBM SKUs of one product share one COG;
--   * seeded once from purchase history, then adjusted by hand on the COG page;
--   * will drive COGS for sales dated 2026-01-01 onward, and follow edits
--     rather than freeze. 2025 stays as it is: it reconciles with InventoryLab
--     to 0.20% and is the year being filed.
--
-- ---- WHAT THIS MIGRATION DOES AND DOES NOT DO ---------------------------
--
-- DOES: create the table and load the reviewed starting averages.
-- DOES NOT: touch sales_orders, the P&L RPCs or any report. Nothing reads this
-- table for COGS yet. Switching 2026 sales onto it is a separate, deliberate
-- step, so the seller can review and adjust these numbers first.
--
-- ---- THE LOAD RULE ------------------------------------------------------
--
-- Exactly the rule previewed in 20260914023000 and reviewed by the seller:
--   1. created_listings lots (Cost Contract A: cost = lot total), cost > 0,
--      units > 0, valid ASIN. NOT created_listing_purchases, which mirrors or
--      splits listing lots and holds $1.00 placeholder batches.
--   2. drop lots under $0.10 a unit (placeholders; all 110 are from 2024);
--   3. drop inverted lots (cost equals amount with units > 1);
--   4. with 3+ remaining lots, drop lots under 1/3 or over 3x the median;
--   5. average = total spent / units, over the last 365 days when 10+ units
--      were bought in that window, else over all remaining lots.
--
-- Exclusions and flags the seller asked for on 2026-09-14:
--   * averages under $0.50 are NOT loaded. The preview found 8, all single-lot
--     placeholders (none sold in 2026). The seller will type those in.
--   * B0G4BQ42W3 (Funko Derpy) is loaded WITHOUT a COG and flagged for review.
--     Confirmed a genuinely mixed-cost product -- units bought at $8.00 as well
--     as $14.50-$17.48 -- so the calculated $14.77 is kept only as a reference
--     (calculated_cost), never as the COG. Leaving unit_cost NULL, rather than
--     loading $14.77 with a flag, means nothing can use the number by mistake
--     before the seller sets it.
--
-- ON CONFLICT DO NOTHING: re-running this, or a later reload, can never
-- overwrite a COG the seller has typed.

CREATE TABLE IF NOT EXISTS public.asin_cog_on_record (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin            TEXT NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  -- NULL = no COG set yet. Distinct from 0, which would be a real (free) cost.
  unit_cost       NUMERIC(12, 4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('import', 'manual')),
  needs_review    BOOLEAN NOT NULL DEFAULT false,
  review_note     TEXT,
  -- What the import calculated, kept for reference beside whatever the seller
  -- sets, so an edited COG can always be compared with purchase history.
  calculated_cost NUMERIC(12, 4),
  calculation     JSONB NOT NULL DEFAULT '{}'::jsonb,
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin)
);

COMMENT ON TABLE public.asin_cog_on_record IS
  'Seller-maintained average COG per ASIN (InventoryLab-style). Seeded 2026-09-14 from created_listings lots; edited on /tools/cog. Not yet read by COGS reports.';
COMMENT ON COLUMN public.asin_cog_on_record.unit_cost IS
  'The COG on record. NULL = not set. Edited by the seller.';
COMMENT ON COLUMN public.asin_cog_on_record.calculated_cost IS
  'Average calculated by the import from purchase lots, for reference only.';

CREATE INDEX IF NOT EXISTS idx_asin_cog_on_record_user_review
  ON public.asin_cog_on_record (user_id, needs_review);

ALTER TABLE public.asin_cog_on_record ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own COG on record" ON public.asin_cog_on_record;
CREATE POLICY "Users manage their own COG on record"
  ON public.asin_cog_on_record FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_asin_cog_on_record_updated_at ON public.asin_cog_on_record;
CREATE TRIGGER update_asin_cog_on_record_updated_at
  BEFORE UPDATE ON public.asin_cog_on_record
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DO $load$
DECLARE
  v_uid uuid;
  v_inserted int;
  r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'seller account not found; nothing loaded';
  END IF;

  INSERT INTO public.asin_cog_on_record
    (user_id, asin, unit_cost, source, needs_review, review_note, calculated_cost, calculation, title)
  WITH lots AS (
    SELECT l.asin, l.units::numeric AS units, l.cost::numeric AS lot_total,
           (l.cost / l.units)::numeric AS unit, l.amount::numeric AS amount,
           CASE WHEN l.date_created::text ~ '^\d{4}-\d{2}-\d{2}'
                THEN left(l.date_created::text, 10)::date ELSE l.created_at::date END AS lot_date,
           l.title
    FROM public.created_listings l
    WHERE l.user_id = v_uid AND l.cost > 0 AND l.units > 0 AND l.asin ~ '^[A-Z0-9]{10}$'
  ), step2 AS (
    SELECT *, (unit < 0.10) AS placeholder,
           (units > 1 AND amount IS NOT NULL AND abs(lot_total - amount) < 0.005) AS inverted
    FROM lots
  ), med AS (
    SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS med, count(*) AS n_lots
    FROM step2 WHERE NOT placeholder AND NOT inverted GROUP BY asin
  ), tagged AS (
    SELECT s.*, (NOT s.placeholder AND NOT s.inverted AND m.n_lots >= 3
                 AND (s.unit < m.med / 3.0 OR s.unit > m.med * 3.0)) AS outlier
    FROM step2 s LEFT JOIN med m USING (asin)
  ), kept AS (
    SELECT * FROM tagged WHERE NOT placeholder AND NOT inverted AND NOT outlier
  ), agg AS (
    SELECT asin,
           sum(lot_total) / sum(units) AS avg_all,
           sum(lot_total) FILTER (WHERE lot_date >= current_date - 365)
             / NULLIF(sum(units) FILTER (WHERE lot_date >= current_date - 365), 0) AS avg_12m,
           sum(units) AS units_all,
           COALESCE(sum(units) FILTER (WHERE lot_date >= current_date - 365), 0) AS units_12m,
           count(*) AS lots_used,
           min(unit) AS min_unit, max(unit) AS max_unit,
           min(lot_date) AS first_date, max(lot_date) AS last_date
    FROM kept GROUP BY asin
  ), latest AS (
    SELECT DISTINCT ON (asin) asin, unit AS last_unit, title
    FROM kept ORDER BY asin, lot_date DESC NULLS LAST, units DESC
  ), excl AS (
    SELECT asin,
           count(*) FILTER (WHERE placeholder) AS n_placeholder,
           count(*) FILTER (WHERE inverted AND NOT placeholder) AS n_inverted,
           count(*) FILTER (WHERE outlier) AS n_outlier
    FROM tagged GROUP BY asin
  ), sold AS (
    SELECT asin, sum(quantity) AS qty_2026,
           sum(total_cost) / NULLIF(sum(quantity), 0) AS cur_unit
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01' AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled') AND quantity > 0
    GROUP BY asin
  ), proposed AS (
    SELECT a.*, lt.last_unit, lt.title, e.n_placeholder, e.n_inverted, e.n_outlier,
           s.qty_2026, s.cur_unit,
           round(CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END, 4) AS cog,
           CASE WHEN a.units_12m >= 10 THEN 'last_12m' ELSE 'all_time' END AS basis
    FROM agg a
    JOIN latest lt USING (asin)
    JOIN excl e USING (asin)
    LEFT JOIN sold s USING (asin)
  )
  SELECT v_uid,
         p.asin,
         CASE WHEN p.asin = 'B0G4BQ42W3' THEN NULL ELSE round(p.cog, 2) END,
         'import',
         (p.asin = 'B0G4BQ42W3'),
         CASE WHEN p.asin = 'B0G4BQ42W3'
              THEN 'Set manually. Confirmed mixed-cost product: units bought at $8.00 and at $14.50-$17.48, '
                   || 'so the calculated average ($' || round(p.cog, 2) || ') is not assumed correct.'
         END,
         round(p.cog, 2),
         jsonb_build_object(
           'rule', 'v3 2026-09-14 (20260914023000)',
           'basis', p.basis,
           'avg_last_12m', round(p.avg_12m, 2),
           'avg_all_time', round(p.avg_all, 2),
           'latest_lot_unit', round(p.last_unit, 2),
           'min_lot_unit', round(p.min_unit, 2),
           'max_lot_unit', round(p.max_unit, 2),
           'units_bought_all', p.units_all,
           'units_bought_12m', p.units_12m,
           'lots_used', p.lots_used,
           'lots_dropped_placeholder', p.n_placeholder,
           'lots_dropped_inverted', p.n_inverted,
           'lots_dropped_outlier', p.n_outlier,
           'first_purchase', p.first_date,
           'last_purchase', p.last_date,
           'units_sold_2026', COALESCE(p.qty_2026, 0),
           'sales_unit_cost_2026', round(p.cur_unit, 2),
           'flags', to_jsonb(array_remove(ARRAY[
             CASE WHEN p.lots_used = 1 THEN 'one_lot' END,
             CASE WHEN p.cog > 0 AND abs(p.last_unit - p.cog) / p.cog > 0.25 THEN 'drift' END,
             CASE WHEN COALESCE(p.qty_2026, 0) > p.units_all THEN 'sold_gt_bought' END,
             CASE WHEN p.cur_unit > 0 AND p.cog > 0 AND abs(p.cur_unit - p.cog) / p.cur_unit > 0.30 THEN 'differs_from_sales' END
           ], NULL))
         ),
         p.title
  FROM proposed p
  WHERE round(p.cog, 2) >= 0.50
  ON CONFLICT (user_id, asin) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'loaded % rows', v_inserted;

  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE unit_cost IS NOT NULL) AS with_cog,
           count(*) FILTER (WHERE needs_review) AS review,
           count(*) FILTER (WHERE calculation ->> 'basis' = 'last_12m') AS b12,
           count(*) FILTER (WHERE calculation ->> 'basis' = 'all_time') AS ball,
           count(*) FILTER (WHERE unit_cost < 0.50) AS under_50c,
           round(min(unit_cost), 2) AS min_cog, round(max(unit_cost), 2) AS max_cog
    FROM public.asin_cog_on_record WHERE user_id = v_uid
  LOOP
    RAISE NOTICE 'table now: % rows | % with a COG | % flagged for review | basis last_12m=% all_time=% | COG under $0.50: % | range $% to $%',
      r.total, r.with_cog, r.review, r.b12, r.ball, r.under_50c, r.min_cog, r.max_cog;
  END LOOP;

  FOR r IN
    SELECT asin, unit_cost, calculated_cost, needs_review, review_note
    FROM public.asin_cog_on_record
    WHERE user_id = v_uid AND asin IN ('B0G4BQ42W3', 'B0B4QQDBQC', 'B00LPP8BJQ', 'B01H0XM5D4', 'B0G4B3117X', 'B00074PE6E')
    ORDER BY asin
  LOOP
    RAISE NOTICE '  % cog=% calculated=% review=% %',
      r.asin, COALESCE(r.unit_cost::text, 'NULL'), r.calculated_cost, r.needs_review, COALESCE(r.review_note, '');
  END LOOP;

  FOR r IN
    SELECT count(*) AS n FROM unnest(ARRAY['B00074PE6E','B0012QP8EY','B002J3SG0W','B002YYPJFG',
                                           'B0052ED1NC','B00AZ0HUSU','B07X9Z6671','B085VFDJ3X']) AS x(asin)
    WHERE EXISTS (SELECT 1 FROM public.asin_cog_on_record c WHERE c.user_id = v_uid AND c.asin = x.asin)
  LOOP
    RAISE NOTICE '  of the 8 sub-$0.50 placeholder products, loaded (should be 0): %', r.n;
  END LOOP;
END
$load$;
