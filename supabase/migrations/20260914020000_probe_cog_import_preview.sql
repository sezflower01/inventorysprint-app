-- READ-ONLY PREVIEW. Creates nothing, changes nothing, loads nothing.
--
-- The seller asked to review the calculated average COG per ASIN BEFORE it is
-- loaded into the new COG-on-record table. This computes exactly what the
-- import would load, and prints:
--   * a summary,
--   * a spot-check sample in the log,
--   * every ASIN as a CSV line (prefix "CSV|") so the full set can be opened
--     in a spreadsheet and any product checked, not only the sample.
--
-- ---- SOURCE -------------------------------------------------------------
--
-- created_listings lots only. Cost Contract A: created_listings.cost is the
-- LOT TOTAL and units the lot size, so a lot's unit cost is cost / units.
--
-- created_listing_purchases is deliberately NOT added in: measured 2026-09-14,
-- 6,224 of its 6,257 rows carry the same unit cost as the listing they hang
-- off, i.e. they mirror the same lots. Adding them would count most purchases
-- twice. The 33 that differ are listed separately for a look.
--
-- ---- THE AVERAGE --------------------------------------------------------
--
-- Weighted by units: total spent / total units, over every kept lot. A 1-unit
-- lot at a strange price moves it far less than a 100-unit lot.
--
-- ---- LOTS EXCLUDED, AND WHY ----------------------------------------------
--
-- inverted: units > 1 and cost equals amount. Under Contract A that means the
--   unit price was typed where the lot total belongs, so the lot's "total" is
--   too small by a factor of its units. The trap recorded in
--   cost-contract-inversion; averaging it in drags the result toward zero.
-- outlier: with 3+ lots, a lot unit cost below a third of or above three times
--   the ASIN's median lot. Catches typos without touching normal price drift.
--
-- Excluded lots are counted per ASIN in the output, never silently dropped.
--
-- ---- FLAGS (reasons to look, not reasons to reject) ----------------------
--
-- one_lot         a single purchase; the average is just that lot.
-- drift           latest lot unit cost differs from the average by > 25%,
--                 i.e. the price has moved and the average blends old and new.
-- sold_gt_bought  more units sold in 2026 than bought in all recorded history,
--                 so purchase history is incomplete for this product.
-- all_excluded    every lot was excluded; nothing to seed, needs a typed COG.

DO $preview$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  CREATE TEMP TABLE cog_preview ON COMMIT DROP AS
  WITH lots AS (
    SELECT l.asin, l.id, l.units::numeric AS units, l.cost::numeric AS lot_total,
           (l.cost / l.units)::numeric AS unit, l.amount::numeric AS amount,
           CASE WHEN l.date_created::text ~ '^\d{4}-\d{2}-\d{2}'
                THEN left(l.date_created::text, 10)::date
                ELSE l.created_at::date END AS lot_date,
           l.title
    FROM public.created_listings l
    WHERE l.user_id = v_uid AND l.cost > 0 AND l.units > 0
      AND l.asin ~ '^[A-Z0-9]{10}$'
  ), med AS (
    SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS med, count(*) AS n_lots
    FROM lots GROUP BY asin
  ), tagged AS (
    SELECT l.*, m.med, m.n_lots,
           (l.units > 1 AND l.amount IS NOT NULL AND abs(l.lot_total - l.amount) < 0.005) AS inverted,
           (m.n_lots >= 3 AND (l.unit < m.med / 3.0 OR l.unit > m.med * 3.0)) AS outlier
    FROM lots l JOIN med m USING (asin)
  ), kept AS (
    SELECT * FROM tagged WHERE NOT inverted AND NOT outlier
  ), agg AS (
    SELECT asin,
           sum(lot_total) / sum(units) AS avg_unit,
           sum(units) AS units_bought,
           count(*) AS lots_kept,
           sum(lot_total) FILTER (WHERE lot_date >= current_date - 365)
             / NULLIF(sum(units) FILTER (WHERE lot_date >= current_date - 365), 0) AS avg_12m,
           min(unit) AS min_unit, max(unit) AS max_unit,
           min(lot_date) AS first_date, max(lot_date) AS last_date
    FROM kept GROUP BY asin
  ), latest AS (
    SELECT DISTINCT ON (asin) asin, unit AS last_unit, title
    FROM kept ORDER BY asin, lot_date DESC NULLS LAST, units DESC
  ), excl AS (
    SELECT asin,
           count(*) FILTER (WHERE inverted) AS n_inverted,
           count(*) FILTER (WHERE outlier AND NOT inverted) AS n_outlier,
           max(title) AS any_title
    FROM tagged GROUP BY asin
  ), sold AS (
    SELECT asin, sum(quantity) AS qty_2026,
           sum(total_cost) AS cogs_2026,
           sum(total_cost) / NULLIF(sum(quantity), 0) AS cur_unit
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
      AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND quantity > 0
    GROUP BY asin
  )
  SELECT e.asin,
         COALESCE(lt.title, e.any_title) AS title,
         round(a.avg_unit, 2) AS avg_unit,
         round(a.avg_12m, 2) AS avg_12m,
         round(lt.last_unit, 2) AS last_unit,
         round(a.min_unit, 2) AS min_unit,
         round(a.max_unit, 2) AS max_unit,
         a.units_bought, a.lots_kept, e.n_inverted, e.n_outlier,
         a.first_date, a.last_date,
         COALESCE(s.qty_2026, 0) AS qty_2026,
         round(s.cur_unit, 2) AS cur_unit_2026,
         round(COALESCE(s.cogs_2026, 0), 2) AS cogs_2026,
         round(COALESCE(a.avg_unit * s.qty_2026, 0), 2) AS cogs_2026_seeded,
         concat_ws(' ',
           CASE WHEN a.asin IS NULL THEN 'all_excluded' END,
           CASE WHEN a.lots_kept = 1 THEN 'one_lot' END,
           CASE WHEN a.avg_unit > 0 AND abs(lt.last_unit - a.avg_unit) / a.avg_unit > 0.25 THEN 'drift' END,
           CASE WHEN COALESCE(s.qty_2026, 0) > COALESCE(a.units_bought, 0) AND a.asin IS NOT NULL THEN 'sold_gt_bought' END
         ) AS flags
  FROM excl e
  LEFT JOIN agg a USING (asin)
  LEFT JOIN latest lt USING (asin)
  LEFT JOIN sold s USING (asin);

  RAISE NOTICE '';
  RAISE NOTICE '======== SUMMARY ========';
  FOR r IN
    SELECT count(*) AS asins,
           count(*) FILTER (WHERE avg_unit IS NOT NULL) AS seedable,
           count(*) FILTER (WHERE flags LIKE '%all_excluded%') AS all_excluded,
           count(*) FILTER (WHERE flags LIKE '%one_lot%') AS one_lot,
           count(*) FILTER (WHERE flags LIKE '%drift%') AS drift,
           count(*) FILTER (WHERE flags LIKE '%sold_gt_bought%') AS sold_gt_bought,
           sum(n_inverted) AS lots_inverted, sum(n_outlier) AS lots_outlier,
           count(*) FILTER (WHERE qty_2026 > 0) AS sold_2026,
           round(sum(cogs_2026) FILTER (WHERE avg_unit IS NOT NULL), 2) AS cogs_now,
           round(sum(cogs_2026_seeded) FILTER (WHERE avg_unit IS NOT NULL), 2) AS cogs_seeded
    FROM cog_preview
  LOOP
    RAISE NOTICE '  ASINs with purchase lots: %  |  would be seeded: %  |  every lot excluded: %',
      r.asins, r.seedable, r.all_excluded;
    RAISE NOTICE '  lots excluded: % inverted (unit price typed as lot total), % outliers', r.lots_inverted, r.lots_outlier;
    RAISE NOTICE '  flags: one_lot=%  drift=%  sold_gt_bought=%', r.one_lot, r.drift, r.sold_gt_bought;
    RAISE NOTICE '  of these, sold in 2026: %', r.sold_2026;
    RAISE NOTICE '  2026 COGS on the seeded ASINs: now $%  ->  seeded $%  (difference $%)',
      r.cogs_now, r.cogs_seeded, round(r.cogs_seeded - r.cogs_now, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== SAMPLE A: top 10 sellers of 2026 ========';
  FOR r IN SELECT * FROM cog_preview WHERE avg_unit IS NOT NULL ORDER BY qty_2026 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % avg=$% (12m $%, last $%, range $%-$%) | % units / % lots % to % | excl inv=% out=% | 2026: % sold, now $%/u -> change $% | %',
      r.asin, r.avg_unit, COALESCE(r.avg_12m::text, '-'), r.last_unit, r.min_unit, r.max_unit,
      r.units_bought, r.lots_kept, r.first_date, r.last_date, r.n_inverted, r.n_outlier,
      r.qty_2026, COALESCE(r.cur_unit_2026::text, '-'),
      round(r.cogs_2026_seeded - r.cogs_2026, 2), NULLIF(r.flags, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== SAMPLE B: biggest change to 2026 COGS ========';
  FOR r IN SELECT * FROM cog_preview WHERE avg_unit IS NOT NULL AND qty_2026 > 0
           ORDER BY abs(cogs_2026_seeded - cogs_2026) DESC LIMIT 10 LOOP
    RAISE NOTICE '  % avg=$% (12m $%, last $%, range $%-$%) | % units / % lots | excl inv=% out=% | 2026: % sold, now $%/u -> change $% | %',
      r.asin, r.avg_unit, COALESCE(r.avg_12m::text, '-'), r.last_unit, r.min_unit, r.max_unit,
      r.units_bought, r.lots_kept, r.n_inverted, r.n_outlier,
      r.qty_2026, COALESCE(r.cur_unit_2026::text, '-'),
      round(r.cogs_2026_seeded - r.cogs_2026, 2), NULLIF(r.flags, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== SAMPLE C: lots the import would exclude (largest first) ========';
  FOR r IN
    WITH lots AS (
      SELECT l.asin, l.units::numeric AS units, l.cost::numeric AS lot_total,
             (l.cost / l.units)::numeric AS unit, l.amount::numeric AS amount, l.date_created
      FROM public.created_listings l
      WHERE l.user_id = v_uid AND l.cost > 0 AND l.units > 0 AND l.asin ~ '^[A-Z0-9]{10}$'
    ), med AS (
      SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY unit) AS med, count(*) AS n
      FROM lots GROUP BY asin
    )
    SELECT l.asin, l.units, l.lot_total, round(l.unit, 2) AS unit, l.amount, round(m.med::numeric, 2) AS med,
           l.date_created,
           CASE WHEN l.units > 1 AND l.amount IS NOT NULL AND abs(l.lot_total - l.amount) < 0.005
                THEN 'inverted' ELSE 'outlier' END AS why
    FROM lots l JOIN med m USING (asin)
    WHERE (l.units > 1 AND l.amount IS NOT NULL AND abs(l.lot_total - l.amount) < 0.005)
       OR (m.n >= 3 AND (l.unit < m.med / 3.0 OR l.unit > m.med * 3.0))
    ORDER BY l.units DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % % | units=% cost=% amount=% -> unit $% vs ASIN median $% | %',
      r.asin, rpad(r.why, 8), r.units, r.lot_total, r.amount, r.unit, r.med, r.date_created;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the 33 purchase rows that do NOT mirror their listing ========';
  FOR r IN
    SELECT p.listing_id, l.asin, p.units AS p_units, p.unit_cost AS p_unit, p.total_cost AS p_total,
           l.units AS l_units, l.amount AS l_unit, l.cost AS l_total
    FROM public.created_listing_purchases p
    JOIN public.created_listings l ON l.id = p.listing_id
    WHERE p.user_id = v_uid AND abs(COALESCE(l.amount, 0) - p.unit_cost) >= 0.01
    ORDER BY p.total_cost DESC NULLS LAST LIMIT 12
  LOOP
    RAISE NOTICE '  % purchase: % u @ $% = $%  | listing: % u @ $% = $%',
      r.asin, r.p_units, r.p_unit, r.p_total, r.l_units, r.l_unit, r.l_total;
  END LOOP;

  -- Full set, one CSV line per ASIN.
  RAISE NOTICE 'CSV|asin,title,proposed_cog,avg_last_12m,latest_lot_unit,min_lot_unit,max_lot_unit,units_bought,lots_used,lots_excluded_inverted,lots_excluded_outlier,first_purchase,last_purchase,units_sold_2026,current_2026_unit_cost,cogs_2026_now,cogs_2026_if_seeded,flags';
  FOR r IN SELECT * FROM cog_preview ORDER BY qty_2026 DESC, asin LOOP
    RAISE NOTICE 'CSV|%,"%",%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%',
      r.asin, replace(COALESCE(r.title, ''), '"', '""'),
      COALESCE(r.avg_unit::text, ''), COALESCE(r.avg_12m::text, ''), COALESCE(r.last_unit::text, ''),
      COALESCE(r.min_unit::text, ''), COALESCE(r.max_unit::text, ''),
      COALESCE(r.units_bought::text, ''), COALESCE(r.lots_kept::text, ''),
      r.n_inverted, r.n_outlier,
      COALESCE(r.first_date::text, ''), COALESCE(r.last_date::text, ''),
      r.qty_2026, COALESCE(r.cur_unit_2026::text, ''), r.cogs_2026, r.cogs_2026_seeded,
      COALESCE(r.flags, '');
  END LOOP;
END
$preview$;
