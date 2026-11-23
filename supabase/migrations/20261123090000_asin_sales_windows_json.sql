-- One-ASIN sales windows, in a shape a row cap cannot cut.
--
-- ── THE BUG THIS REPLACES ─────────────────────────────────────────────────
--
-- extension-create/background.js asked for a listing's whole order history
-- client-side:
--
--     sales_orders?...&select=quantity,order_date&order=order_date.asc&limit=5000
--
-- Two faults compounding. PostgREST's db-max-rows is 1000 on this project and
-- `limit` can only LOWER that, never raise it -- so the request returned 1,000
-- rows while the code assumed 5,000. And the sort was ASCENDING, so the 1,000
-- rows kept were the OLDEST orders and every recent sale was truncated away.
--
-- Reported on B0G4BQ42W3, a listing with more lifetime orders than the cap:
-- the panel showed 7d and 30d as ZERO with a small non-zero 90d figure, while
-- Seller Central showed healthy sales for the same week. That shape is the
-- signature, not a coincidence -- keeping the oldest 1,000 rows of a listing
-- that has outgrown the cap leaves a window that ended months ago, so the
-- short windows empty out and only the longest one still overlaps anything.
--
-- ── WHY AN AGGREGATE AND NOT PAGING ──────────────────────────────────────
--
-- Paging would work, but it moves thousands of rows through the extension to
-- compute six numbers, gets slower as a listing sells more, and leaves the
-- same trap for the next fast seller. Counting server-side is bounded work
-- whatever the volume, and a single jsonb return has no row count to cap.
--
-- Marked STABLE so PostgREST accepts GET as well as POST -- the extension's
-- restGet helper is GET-only and needs no new transport.
--
-- ── THE SALES DEFINITION ─────────────────────────────────────────────────
--
-- Deliberately identical to get_repricer_asin_sales_json (migration
-- 20261119060000), so the extension and the Repricer page cannot disagree:
--   * ASIN normalised uppercase then stripped to A-Z0-9
--   * order_date IS NOT NULL
--   * asin <> 'PENDING'
--   * order_id NOT LIKE '%-REFUND', with coalesce so a NULL order_id is KEPT
--     (no order id is not evidence of a refund)
--   * day boundaries in America/Los_Angeles, because order_date is a local
--     Pacific date -- using UTC moves ~23% of rows across a day boundary
--
-- WINDOW CONVENTION, and it is off by one on purpose: `>= today_pt - 7` spans
-- eight calendar days (today inclusive). That is what get_repricer_asin_sales_json
-- already does, and matching it matters more than matching Amazon. Expect this
-- 7d figure to read slightly ABOVE Seller Central's "Last 7 days" for the same
-- ASIN. It is not a discrepancy to chase.
--
-- VERIFIED 2026-11-22, immediately after this migration was applied, against
-- the same ASIN. Two things were checked and both held:
--
--   1. The 7d figure sat ABOVE Seller Central's "Last 7 days" by almost
--      exactly one day of sales at the listing's own 30-day rate
--      (units_30d / 30). That is the eight-day convention and nothing else --
--      the residual was a couple of units, not a systematic error.
--   2. All of 7d/30d/90d came back substantially non-zero, and lifetime
--      orders did exceed 1000 -- so the precondition for the truncation was
--      present, and the panel's zeros were the cap rather than the market.
--
-- Deliberately no unit counts recorded here: this is a public repository and
-- per-ASIN sales volume is the one thing in this story worth anyone else's
-- while. The arithmetic above is reproducible from the function itself.

CREATE OR REPLACE FUNCTION public.get_asin_sales_windows_json(p_asin text)
  RETURNS jsonb
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS today_pt,
           upper(regexp_replace(coalesce(p_asin, ''), '[^A-Za-z0-9]', '', 'g')) AS asin_key
  ),
  src AS (
    SELECT coalesce(so.quantity, 1) AS qty, so.order_date
    FROM public.sales_orders so
    CROSS JOIN bounds b
    WHERE so.user_id = auth.uid()
      AND so.order_date IS NOT NULL
      AND so.asin IS NOT NULL
      AND so.asin <> 'PENDING'
      AND coalesce(so.order_id, '') NOT LIKE '%-REFUND'
      AND upper(regexp_replace(so.asin, '[^A-Za-z0-9]', '', 'g')) = b.asin_key
  )
  SELECT jsonb_build_object(
    'asin',            b.asin_key,
    'generated_at',    now(),
    'today_pt',        b.today_pt,
    'units_7d',        coalesce(sum(s.qty) FILTER (WHERE s.order_date >= b.today_pt -  7), 0)::int,
    'units_30d',       coalesce(sum(s.qty) FILTER (WHERE s.order_date >= b.today_pt - 30), 0)::int,
    'units_90d',       coalesce(sum(s.qty) FILTER (WHERE s.order_date >= b.today_pt - 90), 0)::int,
    'units_lifetime',  coalesce(sum(s.qty), 0)::int,
    'orders_lifetime', count(s.qty)::int,
    -- Feeds the replenishment forecast: salesPeriodDays is
    -- min(30, days since the earliest order INSIDE the 30-day window), so the
    -- rate is not diluted by days before the listing had any sales.
    'first_order_date_30d', min(s.order_date) FILTER (WHERE s.order_date >= b.today_pt - 30),
    'first_order_date',     min(s.order_date),
    'last_order_date',      max(s.order_date)
  )
  FROM bounds b
  LEFT JOIN src s ON true
  GROUP BY b.asin_key, b.today_pt;
$$;

-- auth.uid() does the scoping inside the function, so EXECUTE is safe for any
-- signed-in user: they can only ever read their own orders.
REVOKE ALL ON FUNCTION public.get_asin_sales_windows_json(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_asin_sales_windows_json(text) TO authenticated;

COMMENT ON FUNCTION public.get_asin_sales_windows_json(text) IS
  'Sales windows for ONE ASIN as a single jsonb value: units_7d / 30d / 90d, lifetime units and orders, and first/last order dates (plus the first order inside the 30-day window, for the replenishment rate). Same sales definition and Pacific day boundaries as get_repricer_asin_sales_json, so the extension and the Repricer page agree. Single-value return cannot be truncated by db-max-rows. Read-only, scoped to auth.uid().';

-- Verify for one ASIN (replace the placeholder, and set the session claim
-- first -- auth.uid() is NULL in the SQL Editor):
--   select set_config('request.jwt.claims',
--          json_build_object('sub', (select id from auth.users
--                                    where email = '<YOUR-EMAIL>'))::text, false);
--   select jsonb_pretty(public.get_asin_sales_windows_json('<ASIN>'));
