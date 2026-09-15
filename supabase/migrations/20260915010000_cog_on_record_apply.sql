-- Switch COG on Record ON: 2026 sales now take their cost from it, edits apply
-- immediately, and every change is logged.
--
-- ---- WHAT THE SELLER DECIDED (2026-09-14) -------------------------------
--
-- Like InventoryLab: editing or adding a COG takes effect at once, for every
-- sale of that product dated 2026-01-01 onward. No "apply from which date"
-- prompt and no separate switch-on per edit -- the seller confirms the average
-- before saving. A change history is kept automatically in the background.
-- 2025 is never touched.
--
-- ---- HOW: WRITE-THROUGH, NOT A NEW READER -------------------------------
--
-- The COG is written into the cost columns every report ALREADY reads
-- (unit_cost, unit_cost_at_sale, total_cost, cost_locked), rather than teaching
-- each report to look up this table. P&L (get_monthly_cogs reads unit_cost;
-- get_cogs_for_range reads the locked snapshot), the browser resolver used by
-- Sales Report / Live Sales / mobile, and the server summaries in
-- _shared/live-sales-core.ts all read those columns. One write path means they
-- cannot drift apart -- the failure that once put web P&L and Excel $2,491.75
-- apart when a category was added to only one of them.
--
-- `cost_locked = true` here does NOT mean frozen in the old sense. It means
-- "use the stored cost", which every reader honours; the stored cost itself
-- follows the COG on record, re-applied on every edit.
--
-- ---- THE PIECES ---------------------------------------------------------
--
-- 1. asin_cog_on_record_history -- who changed which COG, from what, to what,
--    when, and how many sales it re-priced. Written by trigger only.
--
-- 2. zz_apply_cog_on_record, BEFORE INSERT OR UPDATE on sales_orders. For a
--    2026 sale whose ASIN has a COG, it overwrites the cost columns on the way
--    in. This is what makes the COG STICK: sync-sales-orders re-resolves costs
--    from purchase history on every enrichment pass ("self-heal") and would
--    otherwise put the old cost back within minutes. Named zz_ so it runs after
--    the other BEFORE triggers (they fire alphabetically) and has the last word.
--    One indexed lookup per sales write.
--
--    ROI is stored on the row too and must move with cost. Re-implementing the
--    currency-aware revenue logic in SQL would drift from the edge functions,
--    so ROI is re-derived from the incoming pair instead:
--        profit before cost = total_cost x (1 + roi/100)
--        new roi            = (profit before cost - new total) / new total
--    Measured 2026-09-14: that identity holds within 5c on 32,068 of 33,706 US
--    2026 sales. Skipped when fees are missing or invalid (roi 0 there means
--    "unknown", not break-even) and when either total is zero.
--
-- 3. apply_cog_on_record_to_sales(user, asin) -- re-prices one product's 2026
--    sales by touching only the rows that differ; trigger 2 does the rewrite.
--    Measured: B0G4B3117X, the largest at 1,310 rows, took 1,052 ms with the
--    existing triggers -- inside the 8-second authenticated statement_timeout
--    that a save from the page runs under.
--
-- 4. cog_on_record_after_change, AFTER INSERT/UPDATE/DELETE on
--    asin_cog_on_record: applies the new COG and writes the history row.
--
-- 5. One-time activation for the 3,092 COGs already loaded: every affected
--    2026 sale's current cost columns are copied to
--    sales_cost_backup_cog_activation first, then re-priced month by month.
--    The backup makes the activation reversible row for row.
--
-- ---- EDGE CASES, DECIDED ------------------------------------------------
--
-- * ASIN with no COG (NULL, or no row) -> its sales are left alone. That is
--   B0G4BQ42W3 until the seller sets it, and the 136 products sold without
--   purchase records.
-- * A COG cleared to NULL or deleted -> sales keep the last applied cost and
--   the history says so. The page does not offer clearing.
-- * Cancelled rows with quantity 0 get total_cost 0; refund rows (positive
--   quantity and cost, measured) are re-priced like sales so a refund reverses
--   the same cost the sale carried.

-- ── 1. history ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.asin_cog_on_record_history (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin                TEXT NOT NULL,
  action              TEXT NOT NULL CHECK (action IN ('added', 'changed', 'cleared', 'removed')),
  old_unit_cost       NUMERIC(12, 4),
  new_unit_cost       NUMERIC(12, 4),
  old_source          TEXT,
  new_source          TEXT,
  sales_rows_repriced INTEGER NOT NULL DEFAULT 0,
  changed_by          UUID,          -- auth.uid(); NULL when changed by a migration or job
  changed_by_email    TEXT,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.asin_cog_on_record_history IS
  'Every change to asin_cog_on_record, written by trigger. Background safety record for COG edits that re-price 2026 sales.';

CREATE INDEX IF NOT EXISTS idx_cog_history_user_asin
  ON public.asin_cog_on_record_history (user_id, asin, changed_at DESC);

ALTER TABLE public.asin_cog_on_record_history ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner. No insert/update/delete policy: only the SECURITY
-- DEFINER trigger writes, so the log cannot be edited from the browser.
DROP POLICY IF EXISTS "Users read their own COG history" ON public.asin_cog_on_record_history;
CREATE POLICY "Users read their own COG history"
  ON public.asin_cog_on_record_history FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── 2. keep 2026 sales on the COG ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_cog_on_record_to_sale_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cog       NUMERIC;
  v_new_total NUMERIC;
BEGIN
  IF NEW.order_date IS NULL OR NEW.order_date < '2026-01-01' OR NEW.asin IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.unit_cost INTO v_cog
  FROM public.asin_cog_on_record c
  WHERE c.user_id = NEW.user_id AND c.asin = NEW.asin;

  IF v_cog IS NULL THEN
    RETURN NEW;
  END IF;

  v_new_total := round(v_cog * COALESCE(NEW.quantity, 0), 2);

  IF NEW.roi IS NOT NULL
     AND COALESCE(NEW.total_cost, 0) > 0
     AND v_new_total > 0
     AND NOT COALESCE(NEW.fees_invalid, false)
     AND NOT COALESCE(NEW.fees_missing, false)
     AND abs(COALESCE(NEW.total_cost, 0) - v_new_total) >= 0.005 THEN
    NEW.roi := round(((NEW.total_cost * (1 + NEW.roi / 100.0)) - v_new_total) / v_new_total * 100, 1);
  END IF;

  IF NEW.unit_cost IS DISTINCT FROM v_cog
     OR NEW.total_cost IS DISTINCT FROM v_new_total
     OR NEW.cost_locked IS NOT TRUE THEN
    NEW.cost_locked_at := now();
  END IF;

  NEW.unit_cost           := v_cog;
  NEW.unit_cost_at_sale   := v_cog;
  NEW.total_cost          := v_new_total;
  NEW.cost_source_at_sale := 'cog_on_record';
  NEW.cost_locked         := true;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_cog_on_record_to_sale_row() FROM PUBLIC, anon, authenticated;

-- ── 3. re-price one product ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_cog_on_record_to_sales(p_user UUID, p_asin TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cog NUMERIC;
  v_n   INTEGER;
BEGIN
  SELECT unit_cost INTO v_cog FROM public.asin_cog_on_record
  WHERE user_id = p_user AND asin = p_asin;
  IF v_cog IS NULL THEN
    RETURN 0;
  END IF;

  -- A no-op SET: the BEFORE trigger performs the rewrite, so the rule lives in
  -- exactly one place. Only rows that actually differ are touched.
  UPDATE public.sales_orders s
     SET unit_cost = s.unit_cost
   WHERE s.user_id = p_user
     AND s.asin = p_asin
     AND s.order_date >= '2026-01-01'
     AND (s.unit_cost IS DISTINCT FROM v_cog
          OR s.unit_cost_at_sale IS DISTINCT FROM v_cog
          OR s.total_cost IS DISTINCT FROM round(v_cog * COALESCE(s.quantity, 0), 2)
          OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record'
          OR s.cost_locked IS NOT TRUE);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_cog_on_record_to_sales(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ── 4. apply + log on every COG change ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cog_on_record_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $fn$
DECLARE
  v_n      INTEGER := 0;
  v_uid    UUID := auth.uid();
  v_email  TEXT;
  v_action TEXT;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.asin_cog_on_record_history
      (user_id, asin, action, old_unit_cost, new_unit_cost, old_source, new_source,
       sales_rows_repriced, changed_by, changed_by_email)
    VALUES (OLD.user_id, OLD.asin, 'removed', OLD.unit_cost, NULL, OLD.source, NULL,
            0, v_uid, v_email);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost THEN
    RETURN NEW;  -- flag or note edits only; nothing to re-price or log
  END IF;

  IF NEW.unit_cost IS NOT NULL THEN
    v_n := public.apply_cog_on_record_to_sales(NEW.user_id, NEW.asin);
  END IF;

  -- An import row arriving without a COG is not a change anyone made.
  IF TG_OP = 'INSERT' AND NEW.unit_cost IS NULL THEN
    RETURN NEW;
  END IF;

  v_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'added'
    WHEN NEW.unit_cost IS NULL THEN 'cleared'
    ELSE 'changed' END;

  INSERT INTO public.asin_cog_on_record_history
    (user_id, asin, action, old_unit_cost, new_unit_cost, old_source, new_source,
     sales_rows_repriced, changed_by, changed_by_email)
  VALUES (NEW.user_id, NEW.asin, v_action,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.unit_cost END, NEW.unit_cost,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.source END, NEW.source,
          v_n, v_uid, v_email);
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.cog_on_record_after_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cog_on_record_after_change ON public.asin_cog_on_record;
CREATE TRIGGER cog_on_record_after_change
  AFTER INSERT OR UPDATE OF unit_cost OR DELETE ON public.asin_cog_on_record
  FOR EACH ROW EXECUTE FUNCTION public.cog_on_record_after_change();

-- ── 5. one-time activation ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sales_cost_backup_cog_activation (
  sales_order_id      TEXT PRIMARY KEY,   -- text so the backup does not depend on sales_orders.id's type
  user_id             UUID NOT NULL,
  asin                TEXT,
  order_date          DATE,
  unit_cost           NUMERIC,
  unit_cost_at_sale   NUMERIC,
  total_cost          NUMERIC,
  roi                 NUMERIC,
  cost_source_at_sale TEXT,
  cost_locked         BOOLEAN,
  cost_locked_at      TIMESTAMPTZ,
  backed_up_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sales_cost_backup_cog_activation IS
  'Cost columns of every 2026 sale as they were immediately before COG on Record was switched on (20260915010000). Restore source if the activation ever has to be undone.';

ALTER TABLE public.sales_cost_backup_cog_activation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_cost_backup_cog_activation FROM anon, authenticated;

DO $before$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  INSERT INTO public.sales_cost_backup_cog_activation
    (sales_order_id, user_id, asin, order_date, unit_cost, unit_cost_at_sale, total_cost,
     roi, cost_source_at_sale, cost_locked, cost_locked_at)
  SELECT s.id::text, s.user_id, s.asin, s.order_date::date, s.unit_cost, s.unit_cost_at_sale, s.total_cost,
         s.roi, s.cost_source_at_sale, s.cost_locked, s.cost_locked_at
  FROM public.sales_orders s
  JOIN public.asin_cog_on_record c ON c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
  ON CONFLICT (sales_order_id) DO NOTHING;

  FOR r IN
    SELECT count(*) AS rows_backed_up,
           round(sum(total_cost) FILTER (WHERE order_date >= '2026-01-01'), 2) AS cogs
    FROM public.sales_cost_backup_cog_activation WHERE user_id = v_uid
  LOOP
    RAISE NOTICE 'backup: % sales rows, their total_cost $%', r.rows_backed_up, r.cogs;
  END LOOP;

  FOR r IN
    SELECT round(sum(total_cost), 2) AS all_2026,
           round(sum(total_cost) FILTER (WHERE order_id NOT LIKE '%-REFUND'
                   AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled')), 2) AS sales_2026,
           round(sum(total_cost) FILTER (WHERE order_date < '2026-01-01'), 2) AS pre_2026
    FROM public.sales_orders WHERE user_id = v_uid
  LOOP
    RAISE NOTICE 'BEFORE: 2026 total_cost all rows $% | sales only $% | pre-2026 $%',
      r.all_2026, r.sales_2026, r.pre_2026;
  END LOOP;
END
$before$;

-- The rule is live from here: any sales write in this transaction is re-priced.
DROP TRIGGER IF EXISTS zz_apply_cog_on_record ON public.sales_orders;
CREATE TRIGGER zz_apply_cog_on_record
  BEFORE INSERT OR UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.apply_cog_on_record_to_sale_row();

-- Month by month, each its own statement: ~3.3 s per month measured, kept well
-- under the ~120 s statement ceiling. Only rows with a COG and a differing cost.
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-01-01' AND s.order_date < '2026-02-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-02-01' AND s.order_date < '2026-03-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-03-01' AND s.order_date < '2026-04-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-04-01' AND s.order_date < '2026-05-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-05-01' AND s.order_date < '2026-06-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-06-01' AND s.order_date < '2026-07-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-07-01' AND s.order_date < '2026-08-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-08-01' AND s.order_date < '2026-09-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);
UPDATE public.sales_orders s SET unit_cost = s.unit_cost
FROM public.asin_cog_on_record c
WHERE c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
  AND s.order_date >= '2026-09-01'
  AND (s.unit_cost IS DISTINCT FROM c.unit_cost OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
       OR s.cost_source_at_sale IS DISTINCT FROM 'cog_on_record' OR s.cost_locked IS NOT TRUE OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost);

-- ── verification ───────────────────────────────────────────────────────────

DO $after$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    SELECT round(sum(total_cost), 2) AS all_2026,
           round(sum(total_cost) FILTER (WHERE order_id NOT LIKE '%-REFUND'
                   AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled')), 2) AS sales_2026,
           count(*) FILTER (WHERE cost_source_at_sale = 'cog_on_record') AS on_cog
    FROM public.sales_orders WHERE user_id = v_uid AND order_date >= '2026-01-01'
  LOOP
    RAISE NOTICE 'AFTER:  2026 total_cost all rows $% | sales only $% | rows on COG: %',
      r.all_2026, r.sales_2026, r.on_cog;
  END LOOP;

  FOR r IN
    SELECT round(sum(total_cost), 2) AS pre_2026, count(*) FILTER (WHERE cost_source_at_sale = 'cog_on_record') AS wrongly
    FROM public.sales_orders WHERE user_id = v_uid AND order_date < '2026-01-01'
  LOOP
    RAISE NOTICE 'pre-2026 total_cost $% (must equal BEFORE) | pre-2026 rows on COG: % (must be 0)', r.pre_2026, r.wrongly;
  END LOOP;

  FOR r IN
    SELECT count(*) AS mismatched
    FROM public.sales_orders s
    JOIN public.asin_cog_on_record c ON c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND (s.unit_cost IS DISTINCT FROM c.unit_cost
           OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2))
  LOOP
    RAISE NOTICE '2026 sales with a COG whose stored cost does not match it: % (must be 0)', r.mismatched;
  END LOOP;

  FOR r IN
    SELECT count(*) AS n, count(*) FILTER (WHERE cost_source_at_sale = 'cog_on_record') AS on_cog
    FROM public.sales_orders WHERE user_id = v_uid AND asin = 'B0G4BQ42W3' AND order_date >= '2026-01-01'
  LOOP
    RAISE NOTICE 'B0G4BQ42W3 (no COG yet): % 2026 rows, % on COG (must be 0)', r.n, r.on_cog;
  END LOOP;

  FOR r IN
    SELECT s.asin, count(*) AS n, min(s.unit_cost) AS unit, round(avg(b.unit_cost), 2) AS was_avg,
           round(sum(s.total_cost), 2) AS cogs_now, round(sum(b.total_cost), 2) AS cogs_was
    FROM public.sales_orders s
    JOIN public.sales_cost_backup_cog_activation b ON b.sales_order_id = s.id::text
    WHERE s.user_id = v_uid AND s.asin IN ('B0G4B3117X', 'B0G1KRKM89', 'B071GWMDWD', 'B01H0XM5D4')
      AND s.order_id NOT LIKE '%-REFUND' AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
    GROUP BY s.asin ORDER BY s.asin
  LOOP
    RAISE NOTICE '  % rows=% unit now $% (was avg $%) | COGS $% (was $%)',
      r.asin, r.n, r.unit, r.was_avg, r.cogs_now, r.cogs_was;
  END LOOP;

  FOR r IN
    SELECT count(*) AS rows_with_roi,
           count(*) FILTER (WHERE abs(s.total_cost * (1 + s.roi / 100.0) - b.total_cost * (1 + b.roi / 100.0)) <= 0.10) AS same_profit_before_cost
    FROM public.sales_orders s
    JOIN public.sales_cost_backup_cog_activation b ON b.sales_order_id = s.id::text
    WHERE s.user_id = v_uid AND s.roi IS NOT NULL AND b.roi IS NOT NULL
      AND s.total_cost > 0 AND b.total_cost > 0
      AND NOT COALESCE(s.fees_invalid, false) AND NOT COALESCE(s.fees_missing, false)
  LOOP
    RAISE NOTICE 'ROI check: % re-priced rows with ROI; % keep the same profit-before-cost within 10c',
      r.rows_with_roi, r.same_profit_before_cost;
  END LOOP;

  FOR r IN SELECT count(*) AS n FROM public.asin_cog_on_record_history LOOP
    RAISE NOTICE 'history rows written by activation: % (expect 0 -- activation is not a COG edit)', r.n;
  END LOOP;
END
$after$;
