-- Two read aggregates for the repricer table, replacing ~36 paged REST round
-- trips with one call each.
--
-- WHY THIS EXISTS
--
-- Measured in the live UI on 2026-11-19 with the client caches cleared (so the
-- cold path actually runs): opening /tools/repricer made 145 Supabase requests
-- and network work was still finishing at 16.6 SECONDS, to annotate 898
-- listings. The single worst contributor was fetchSalesEnrichment in
-- src/components/repricer/AssignmentsTable.tsx, which paged ALL of
-- sales_orders filtered on user_id alone -- 24 pages of 1,000 rows, max offset
-- 23,000, each page awaiting the previous one. That is ~15 seconds of SERIAL
-- latency spent shipping ~29,000 rows to the browser so JavaScript could sum
-- quantity per ASIN. The answer is ~900 rows. A further pair of full-table
-- scans (created_listings, and sales_orders again for image_url) did the same
-- thing for titles and images.
--
-- These functions do the grouping in Postgres, where it is one index/seq scan
-- and milliseconds, and return only the ~900 rows that are actually displayed.
--
-- A CORRECTNESS FIX RIDES ALONG, AND IT CHANGES A DISPLAYED NUMBER
--
-- The client's four sales columns did not agree on what a sale is. today, 7d
-- and 30d each excluded asin = 'PENDING' and order_id like '%-REFUND'; the
-- lifetime ("Historical") scan excluded NOTHING but user_id. So the Historical
-- column counted refunds and PENDING rows while the other three did not, and
-- the four were not comparable to each other. With 19,724 orders stuck at
-- status Pending (see the order_status-never-updates finding) that is not a
-- rounding difference.
--
-- One filter is now applied once, here, for all four windows. Expect the
-- Historical column to DROP for ASINs that have refunds -- that is the fix
-- landing, not a regression.
--
-- WHICH DATE FIELD, STATED EXPLICITLY
--
-- order_date, which is Amazon's LOCAL (US Pacific) date and is complete.
-- NOT purchase_timestamp_utc, which is UTC and NULL on ~10% of rows; 23% of
-- rows fall on a different calendar day between the two, so mixing them moves
-- roughly a quarter of rows between days. "Today" is therefore the current
-- date in America/Los_Angeles, which is exactly what the client computed with
-- toLocaleDateString -- the window boundaries are unchanged by this migration.
--
-- NO p_user_id PARAMETER, ON PURPOSE
--
-- These scope by auth.uid() rather than taking a user id, so a caller cannot
-- ask for someone else's sales. The cost is that running them in the SQL
-- Editor returns zero rows unless you set the claim first:
--   select set_config('request.jwt.claims', '{"sub":"<user-uuid>"}', true);
-- That trap already cost a debugging cycle on the P&L RPC.

-- ---------------------------------------------------------------- sales
CREATE OR REPLACE FUNCTION public.get_repricer_asin_sales()
 RETURNS TABLE (
   asin text,
   units_today integer,
   units_7d integer,
   units_30d integer,
   units_lifetime integer,
   first_order_date date,
   last_order_date date
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS today_pt
  ),
  -- Normalisation matches normalizeIdentifier() in AssignmentsTable.tsx
  -- exactly: uppercase, then strip everything that is not A-Z0-9. The maps it
  -- builds are keyed that way, so any other rule here would silently fail to
  -- join for a subset of ASINs.
  src AS (
    SELECT
      upper(regexp_replace(coalesce(so.asin, ''), '[^A-Za-z0-9]', '', 'g')) AS asin_key,
      coalesce(so.quantity, 1) AS qty,
      so.order_date
    FROM public.sales_orders so
    WHERE so.user_id = auth.uid()
      AND so.order_date IS NOT NULL
      AND so.asin IS NOT NULL
      AND so.asin <> 'PENDING'
      -- coalesce so a NULL order_id is kept rather than silently dropped: a
      -- row with no order id is not evidence of a refund. PostgREST's
      -- .not("order_id","like",...) evaluates to NULL and drops it, which is
      -- how the three short windows and the lifetime scan came to disagree on
      -- their row counts as well as their filters.
      AND coalesce(so.order_id, '') NOT LIKE '%-REFUND'
    ),
  agg AS (
    SELECT
      s.asin_key,
      sum(CASE WHEN s.order_date = b.today_pt THEN s.qty ELSE 0 END)::int AS units_today,
      sum(CASE WHEN s.order_date >= b.today_pt - 7 THEN s.qty ELSE 0 END)::int AS units_7d,
      sum(CASE WHEN s.order_date >= b.today_pt - 30 THEN s.qty ELSE 0 END)::int AS units_30d,
      sum(s.qty)::int AS units_lifetime,
      min(s.order_date) AS first_order_date,
      max(s.order_date) AS last_order_date
    FROM src s CROSS JOIN bounds b
    WHERE s.asin_key <> ''
    GROUP BY s.asin_key
  ),
  -- Today only, and only ever as a FLOOR via greatest() below. The daily
  -- rollup can be ahead of sales_orders for the current day, which is why the
  -- client hedged with Math.max; that hedge is preserved rather than trusted.
  -- It is NOT used for the longer windows: backfill_daily_rollup in
  -- sync-sales-orders is opt-in with days_back defaulting to 7, so historical
  -- coverage of this table is unverified and must not become the source of a
  -- lifetime figure.
  rollup AS (
    SELECT
      upper(regexp_replace(coalesce(d.asin, ''), '[^A-Za-z0-9]', '', 'g')) AS asin_key,
      max(coalesce(d.units, 0))::int AS units
    FROM public.asin_sales_daily d CROSS JOIN bounds b
    WHERE d.user_id = auth.uid()
      AND d.date = b.today_pt
    GROUP BY 1
  )
  SELECT
    coalesce(a.asin_key, r.asin_key) AS asin,
    greatest(coalesce(a.units_today, 0), coalesce(r.units, 0)) AS units_today,
    coalesce(a.units_7d, 0) AS units_7d,
    coalesce(a.units_30d, 0) AS units_30d,
    coalesce(a.units_lifetime, 0) AS units_lifetime,
    a.first_order_date,
    a.last_order_date
  -- FULL OUTER so an ASIN that appears only in today's rollup still reports a
  -- today figure, as the client's merged dictionary did.
  FROM agg a FULL OUTER JOIN rollup r ON r.asin_key = a.asin_key
  WHERE coalesce(a.asin_key, r.asin_key) <> '';
$$;

COMMENT ON FUNCTION public.get_repricer_asin_sales() IS
  'Per-ASIN unit counts for the repricer table: today / 7d / 30d / lifetime, plus '
  'first and last order date. Replaces ~33 paged sales_orders REST reads (~29,000 '
  'rows, ~15s of serial latency) with one call returning ~900 rows. Dates come from '
  'order_date (LOCAL Pacific, complete) -- never purchase_timestamp_utc, which is UTC '
  'and NULL on ~10% of rows. ONE filter serves all four windows (asin <> PENDING, '
  'order_id not like %-REFUND), which fixes the Historical column having counted '
  'refunds and PENDING rows while the other three excluded them. Scoped by auth.uid(); '
  'in the SQL Editor set request.jwt.claims first or it returns nothing.';

-- ---------------------------------------------------------------- title/image
CREATE OR REPLACE FUNCTION public.get_repricer_asin_media()
 RETURNS TABLE (
   asin text,
   title text,
   image_url text
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  WITH candidates AS (
    -- created_listings first: priority 1 wins ties below, matching the
    -- client, which seeded titleImageMap from created_listings and then let
    -- sales_orders fill only the gaps (existing?.title || so.title).
    SELECT
      upper(regexp_replace(coalesce(cl.asin, ''), '[^A-Za-z0-9]', '', 'g')) AS asin_key,
      1 AS priority,
      nullif(btrim(cl.title), '') AS title,
      nullif(btrim(cl.image_url), '') AS image_url,
      cl.created_at
    FROM public.created_listings cl
    WHERE cl.user_id = auth.uid()
      AND cl.asin IS NOT NULL

    UNION ALL

    SELECT
      upper(regexp_replace(coalesce(so.asin, ''), '[^A-Za-z0-9]', '', 'g')) AS asin_key,
      2 AS priority,
      nullif(btrim(so.title), '') AS title,
      nullif(btrim(so.image_url), '') AS image_url,
      so.created_at
    FROM public.sales_orders so
    WHERE so.user_id = auth.uid()
      AND so.asin IS NOT NULL
      AND so.asin <> 'PENDING'
      AND so.image_url IS NOT NULL
  )
  SELECT
    c.asin_key AS asin,
    -- Per FIELD, not per row: a created_listings row with an image but no
    -- title must not block a title that exists on a sales_orders row. The
    -- client's `existing?.title || cl.title` chain had the same per-field
    -- behaviour, one row at a time.
    (array_agg(c.title ORDER BY c.priority, c.created_at DESC NULLS LAST)
       FILTER (WHERE c.title IS NOT NULL))[1] AS title,
    (array_agg(c.image_url ORDER BY c.priority, c.created_at DESC NULLS LAST)
       FILTER (WHERE c.image_url IS NOT NULL))[1] AS image_url
  FROM candidates c
  WHERE c.asin_key <> ''
  GROUP BY c.asin_key
  HAVING count(c.title) > 0 OR count(c.image_url) > 0;
$$;

COMMENT ON FUNCTION public.get_repricer_asin_media() IS
  'Best known title and image per ASIN for the repricer table, preferring '
  'created_listings over sales_orders and resolving each field independently. '
  'Replaces two full-table client scans (all of created_listings, plus all of '
  'sales_orders where image_url is not null) with one call returning only ASINs that '
  'have at least one of the two. Scoped by auth.uid().';

-- Deliberately no new index. The lifetime aggregate has to visit every one of
-- the user''s sales_orders rows whatever we do; the win here is that it happens
-- once inside Postgres instead of 24 times across the network. Measure before
-- adding one.

-- Explicit, rather than relying on the default PUBLIC EXECUTE grant. These are
-- SECURITY DEFINER functions, so who may call them should be stated, not
-- inherited; auth.uid() inside them is what limits each caller to their own
-- rows.
GRANT EXECUTE ON FUNCTION public.get_repricer_asin_sales() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_repricer_asin_media() TO authenticated;
