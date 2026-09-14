-- READ-ONLY PREVIEW, v3. Creates nothing, changes nothing, loads nothing.
--
-- v2 (20260914022000) used the last-12-months average whenever ANY purchase
-- fell in the window. The review sample showed why that is fragile:
-- B0B4QQDBQC (The Chosen: Season 2 DVD) would have loaded at $1.00, because
-- its only recent purchase was ONE unit at $1 -- against an all-time average
-- of $12.41 and a current 2026 sales cost of $10.67. A single unit is not a
-- price.
--
-- v3: the last-12-months average is used only when at least 10 units were
-- bought in the window; otherwise the all-time average. Everything else is as
-- v2, whose header follows.
---- (v2 header)
--
-- Supersedes the rule previewed in 20260914020000, after
-- 20260914021000 measured two weaknesses in it:
--
--   PLACEHOLDER LOTS. 110 lots cost under $0.10 a unit -- all dated 2024, mostly
--   a $1 lot total for hundreds of units. They sit in 94 ASINs, 84 of which
--   have fewer than 3 lots, where the median-based outlier guard cannot see
--   them. B00LPP8BJQ averaged $4.73 from lots of $0.01 and $12.12. Now dropped
--   outright, whatever the lot count.
--
--   OLD PRICES. The COG applies to 2026 sales, so an all-time average that
--   leans on cheap 2024-25 bulk lots misstates them (B01H0XM5D4: all-time
--   $9.92, last 12 months $11.04). Proposed COG is now the last-12-months
--   weighted average, falling back to all-time only when an ASIN has no
--   purchase in the last 12 months. Measured on 2026 sales: 23 ASINs move by
--   more than $100 (27 under all-time), total absolute movement $15,965
--   ($17,668 under all-time).
--
-- Rule, in order:
--   1. created_listings lots, cost > 0, units > 0, valid ASIN.
--   2. drop lots under $0.10 a unit                      (placeholder)
--   3. drop lots whose cost equals amount with units > 1 (inverted)
--   4. with 3+ remaining lots, drop lots under 1/3 or over 3x the median (outlier)
--   5. proposed COG = sum(lot totals) / sum(units) over lots from the last 365
--      days; if none, over all remaining lots.
--
-- Output: summary, then every ASIN as a CSV line (prefix "CSV|").

DO $preview$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  CREATE TEMP TABLE cog_preview ON COMMIT DROP AS
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
           sum(units) FILTER (WHERE lot_date >= current_date - 365) AS units_12m,
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
           count(*) FILTER (WHERE outlier) AS n_outlier,
           max(title) AS any_title
    FROM tagged GROUP BY asin
  ), sold AS (
    SELECT asin, sum(quantity) AS qty_2026, sum(total_cost) AS cogs_2026,
           sum(total_cost) / NULLIF(sum(quantity), 0) AS cur_unit
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01' AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled') AND quantity > 0
    GROUP BY asin
  )
  SELECT e.asin,
         COALESCE(lt.title, e.any_title) AS title,
         round((CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END), 2) AS proposed,
         CASE WHEN a.units_12m >= 10 THEN 'last_12m' WHEN a.avg_all IS NOT NULL THEN 'all_time' END AS basis,
         round(a.avg_all, 2) AS avg_all, round(a.avg_12m, 2) AS avg_12m,
         round(lt.last_unit, 2) AS last_unit, round(a.min_unit, 2) AS min_unit, round(a.max_unit, 2) AS max_unit,
         a.units_all, a.units_12m, a.lots_used, e.n_placeholder, e.n_inverted, e.n_outlier,
         a.first_date, a.last_date,
         COALESCE(s.qty_2026, 0) AS qty_2026,
         round(s.cur_unit, 2) AS cur_unit,
         round(COALESCE(s.cogs_2026, 0), 2) AS cogs_now,
         round(COALESCE((CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END) * s.qty_2026, 0), 2) AS cogs_seeded,
         concat_ws(' ',
           CASE WHEN a.asin IS NULL THEN 'nothing_to_seed' END,
           CASE WHEN a.lots_used = 1 THEN 'one_lot' END,
           CASE WHEN (CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END) > 0
                 AND abs(lt.last_unit - (CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END)) / (CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END) > 0.25 THEN 'drift' END,
           CASE WHEN a.asin IS NOT NULL AND COALESCE(s.qty_2026, 0) > a.units_all THEN 'sold_gt_bought' END,
           CASE WHEN s.cur_unit > 0 AND (CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END) > 0
                 AND abs(s.cur_unit - (CASE WHEN a.units_12m >= 10 THEN a.avg_12m ELSE a.avg_all END)) / s.cur_unit > 0.30 THEN 'differs_from_sales' END
         ) AS flags
  FROM excl e
  LEFT JOIN agg a USING (asin)
  LEFT JOIN latest lt USING (asin)
  LEFT JOIN sold s USING (asin);

  RAISE NOTICE '';
  RAISE NOTICE '======== SUMMARY ========';
  FOR r IN
    SELECT count(*) AS asins,
           count(*) FILTER (WHERE proposed IS NOT NULL) AS seedable,
           count(*) FILTER (WHERE basis = 'last_12m') AS b12, count(*) FILTER (WHERE basis = 'all_time') AS ball,
           count(*) FILTER (WHERE flags LIKE '%nothing_to_seed%') AS nothing,
           sum(n_placeholder) AS ph, sum(n_inverted) AS inv, sum(n_outlier) AS outl,
           count(*) FILTER (WHERE flags LIKE '%one_lot%') AS one_lot,
           count(*) FILTER (WHERE flags LIKE '%drift%') AS drift,
           count(*) FILTER (WHERE flags LIKE '%sold_gt_bought%') AS sgb,
           count(*) FILTER (WHERE flags LIKE '%differs_from_sales%') AS dfs,
           count(*) FILTER (WHERE qty_2026 > 0 AND proposed IS NOT NULL) AS sold26,
           round(sum(cogs_now) FILTER (WHERE proposed IS NOT NULL), 2) AS now_t,
           round(sum(cogs_seeded) FILTER (WHERE proposed IS NOT NULL), 2) AS seed_t,
           count(*) FILTER (WHERE proposed IS NOT NULL AND proposed < 0.50) AS under_50c
    FROM cog_preview
  LOOP
    RAISE NOTICE '  ASINs with purchase lots: %  |  seedable: % (% from last 12 months, % all-time)  |  nothing to seed: %',
      r.asins, r.seedable, r.b12, r.ball, r.nothing;
    RAISE NOTICE '  lots dropped: % placeholder, % inverted, % outlier', r.ph, r.inv, r.outl;
    RAISE NOTICE '  flags: one_lot=% drift=% sold_gt_bought=% differs_from_sales=%', r.one_lot, r.drift, r.sgb, r.dfs;
    RAISE NOTICE '  proposed COGs under $0.50: %', r.under_50c;
    RAISE NOTICE '  seedable ASINs sold in 2026: %  |  their 2026 COGS now $%  ->  $%  (change $%)',
      r.sold26, r.now_t, r.seed_t, round(r.seed_t - r.now_t, 2);
  END LOOP;

  RAISE NOTICE 'CSV|asin,title,proposed_cog,basis,avg_last_12m,avg_all_time,latest_lot_unit,min_lot_unit,max_lot_unit,units_bought_all,units_bought_12m,lots_used,lots_dropped_placeholder,lots_dropped_inverted,lots_dropped_outlier,first_purchase,last_purchase,units_sold_2026,current_2026_unit_cost,cogs_2026_now,cogs_2026_with_proposed,change,flags';
  FOR r IN SELECT * FROM cog_preview ORDER BY abs(cogs_seeded - cogs_now) DESC, qty_2026 DESC, asin LOOP
    RAISE NOTICE 'CSV|%,"%",%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%,%',
      r.asin, replace(COALESCE(r.title, ''), '"', '""'),
      COALESCE(r.proposed::text, ''), COALESCE(r.basis, ''),
      COALESCE(r.avg_12m::text, ''), COALESCE(r.avg_all::text, ''), COALESCE(r.last_unit::text, ''),
      COALESCE(r.min_unit::text, ''), COALESCE(r.max_unit::text, ''),
      COALESCE(r.units_all::text, ''), COALESCE(r.units_12m::text, ''), COALESCE(r.lots_used::text, ''),
      r.n_placeholder, r.n_inverted, r.n_outlier,
      COALESCE(r.first_date::text, ''), COALESCE(r.last_date::text, ''),
      r.qty_2026, COALESCE(r.cur_unit::text, ''), r.cogs_now, r.cogs_seeded,
      round(r.cogs_seeded - r.cogs_now, 2), COALESCE(r.flags, '');
  END LOOP;
END
$preview$;
