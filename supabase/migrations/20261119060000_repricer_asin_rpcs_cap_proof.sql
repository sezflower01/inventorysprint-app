-- The two repricer aggregates were capped at 1,000 rows, silently.
--
-- WHAT HAPPENED
--
-- 20261119040000 defined get_repricer_asin_sales() and
-- get_repricer_asin_media() as RETURNS TABLE. PostgREST serves a
-- set-returning function as a table-like resource, so db-max-rows (1,000 on
-- this project) truncates it exactly as it truncates a select. Confirmed from
-- the live console within minutes of the migration being applied:
--
--   [Repricer] Sales enrichment done in 2485ms:
--   today=1000, 7d=1000, 30d=1000, historical=1000, media=1000 ASINs
--
-- Five exact 1,000s. No real data produces that. Every ASIN past the first
-- 1,000 silently had no sales figures and no title/image, and nothing
-- errored -- which is the dangerous part, because the Historical column would
-- have read as "no sales" rather than "not loaded".
--
-- This is the SAME defect, in the same week, as the shipment-items cursor:
-- a full page is not evidence the rows ran out. The lesson recorded there was
-- "page until a page comes back short". It did not get applied here because an
-- RPC does not look like a paged read -- but PostgREST does not care what it
-- looks like.
--
-- THE FIX: ONE ROW, WHICH CANNOT BE TRUNCATED
--
-- Both functions now RETURN jsonb -- a single value in a single row. A 1,000-
-- row cap cannot cut one row, so the failure mode is removed by construction
-- rather than by choosing a bigger number that would silently become wrong
-- again at some future ASIN count. This is the shape get_managed_listings_counts
-- already uses, for the same reason.
--
-- The old RETURNS TABLE versions are DROPPED, not left in place, so no caller
-- can keep quietly reading the capped shape. Both deploy orders are safe: a
-- client that calls a missing function logs a warning and falls back to its
-- own properly-paged scan, which is slow but complete.
--
-- THE ENVELOPE ANSWERS "HOW MANY ASINS ARE THERE REALLY?"
--
-- Each function returns { generated_at, rows, truncated, asins }. `rows` is
-- the TRUE count, computed before any limit is applied, so the browser console
-- now reports the real figure on every load -- which is the number that was
-- impossible to know from a capped API read. `p_max_asins` is a blast-radius
-- guard, not a cap on truth: if `rows` exceeds it, `asins` is omitted and
-- `truncated` is true, and the client is required to fall back to its paged
-- scan and log an error. A payload is never silently short.
--
-- Dates and filters are unchanged from 20261119040000: order_date (LOCAL
-- Pacific, complete -- never purchase_timestamp_utc), and one filter
-- (asin <> 'PENDING', order_id not like '%-REFUND') serving all four windows.

DROP FUNCTION IF EXISTS public.get_repricer_asin_sales();
DROP FUNCTION IF EXISTS public.get_repricer_asin_media();

-- ---------------------------------------------------------------- sales
CREATE OR REPLACE FUNCTION public.get_repricer_asin_sales_json(p_max_asins integer DEFAULT 50000)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS today_pt
  ),
  -- Normalisation matches normalizeIdentifier() in the client exactly:
  -- uppercase, then strip everything that is not A-Z0-9. Any other rule here
  -- would silently fail to join for a subset of ASINs.
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
      -- coalesce so a NULL order_id is kept rather than dropped: a row with no
      -- order id is not evidence of a refund.
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
  -- Today only, and only ever as a FLOOR via greatest(). The daily rollup can
  -- be ahead of sales_orders for the current day. It is NOT used for the longer
  -- windows: backfill_daily_rollup in sync-sales-orders is opt-in with
  -- days_back defaulting to 7, so its historical coverage is unverified.
  rollup AS (
    SELECT
      upper(regexp_replace(coalesce(d.asin, ''), '[^A-Za-z0-9]', '', 'g')) AS asin_key,
      max(coalesce(d.units, 0))::int AS units
    FROM public.asin_sales_daily d CROSS JOIN bounds b
    WHERE d.user_id = auth.uid()
      AND d.date = b.today_pt
    GROUP BY 1
  ),
  merged AS (
    SELECT
      coalesce(a.asin_key, r.asin_key) AS asin,
      greatest(coalesce(a.units_today, 0), coalesce(r.units, 0)) AS today,
      coalesce(a.units_7d, 0) AS d7,
      coalesce(a.units_30d, 0) AS d30,
      coalesce(a.units_lifetime, 0) AS life,
      a.first_order_date AS first_sale,
      a.last_order_date AS last_sale
    -- FULL OUTER so an ASIN present only in today's rollup still reports today.
    FROM agg a FULL OUTER JOIN rollup r ON r.asin_key = a.asin_key
    WHERE coalesce(a.asin_key, r.asin_key) <> ''
  ),
  counted AS (SELECT count(*)::int AS n FROM merged)
  SELECT jsonb_build_object(
    'generated_at', now(),
    -- The TRUE count, before any guard. This is the figure a capped API read
    -- could never show.
    'rows', c.n,
    'truncated', c.n > p_max_asins,
    'asins', CASE
      WHEN c.n > p_max_asins THEN NULL
      ELSE coalesce((
        SELECT jsonb_object_agg(m.asin, jsonb_build_object(
          'today', m.today,
          'd7', m.d7,
          'd30', m.d30,
          'life', m.life,
          'first', m.first_sale,
          'last', m.last_sale
        )) FROM merged m
      ), '{}'::jsonb)
    END
  )
  FROM counted c;
$$;

COMMENT ON FUNCTION public.get_repricer_asin_sales_json(integer) IS
  'Per-ASIN unit counts for the repricer table (today / 7d / 30d / lifetime, plus '
  'first and last order date) as a SINGLE jsonb value, so PostgREST''s 1,000-row '
  'db-max-rows cap cannot truncate it -- which is exactly what happened to the '
  'RETURNS TABLE version this replaces. The envelope carries the TRUE row count and '
  'a truncated flag; when truncated is true, asins is NULL and the caller must use '
  'its own paged scan. Dates come from order_date (LOCAL Pacific, complete), never '
  'purchase_timestamp_utc. ONE filter serves all four windows. Scoped by auth.uid(); '
  'in the SQL Editor set request.jwt.claims first or it returns nothing.';

-- ---------------------------------------------------------------- title/image
CREATE OR REPLACE FUNCTION public.get_repricer_asin_media_json(p_max_asins integer DEFAULT 50000)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  WITH candidates AS (
    -- created_listings first: priority 1 wins ties below, matching the client,
    -- which seeded from created_listings and let sales_orders fill only gaps.
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
  ),
  resolved AS (
    SELECT
      c.asin_key AS asin,
      -- Per FIELD, not per row: a created_listings row with an image but no
      -- title must not block a title that exists on a sales_orders row.
      (array_agg(c.title ORDER BY c.priority, c.created_at DESC NULLS LAST)
         FILTER (WHERE c.title IS NOT NULL))[1] AS title,
      (array_agg(c.image_url ORDER BY c.priority, c.created_at DESC NULLS LAST)
         FILTER (WHERE c.image_url IS NOT NULL))[1] AS image_url
    FROM candidates c
    WHERE c.asin_key <> ''
    GROUP BY c.asin_key
    HAVING count(c.title) > 0 OR count(c.image_url) > 0
  ),
  counted AS (SELECT count(*)::int AS n FROM resolved)
  SELECT jsonb_build_object(
    'generated_at', now(),
    'rows', c.n,
    'truncated', c.n > p_max_asins,
    'asins', CASE
      WHEN c.n > p_max_asins THEN NULL
      ELSE coalesce((
        SELECT jsonb_object_agg(r.asin, jsonb_build_object(
          'title', r.title,
          'image', r.image_url
        )) FROM resolved r
      ), '{}'::jsonb)
    END
  )
  FROM counted c;
$$;

COMMENT ON FUNCTION public.get_repricer_asin_media_json(integer) IS
  'Best known title and image per ASIN for the repricer table, preferring '
  'created_listings over sales_orders and resolving each field independently, as a '
  'SINGLE jsonb value so the 1,000-row cap cannot truncate it. Carries the true row '
  'count and a truncated flag. Replaces two full-table client scans. Scoped by '
  'auth.uid().';

GRANT EXECUTE ON FUNCTION public.get_repricer_asin_sales_json(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_repricer_asin_media_json(integer) TO authenticated;

-- Still no new index: the lifetime aggregate must visit every one of the
-- user''s sales_orders rows whatever we do. If the console reports enrichment
-- still costing seconds once this is applied, measure which of the two calls
-- it is (the client now logs them separately) before adding one.
