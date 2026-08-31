-- FBM shipping label cost: get it into the P&L, and stop the poller losing it.
--
-- ── WHERE THE MONEY ACTUALLY IS ───────────────────────────────────────────
--
-- 20260831140000 wired financial_events_cache.fbm_shipping_label_fee through
-- both P&L RPCs on the assumption the data was already there. It was not --
-- applying that migration reported 0.00 for the whole year, and the column has
-- never held a non-zero value. Amazon does not deliver this seller's FBM label
-- costs as financial events.
--
-- The money lives in sales_orders.shipping_label_fee, written by
-- sync-fbm-label-cost / poll-fbm-label-costs, and rendered in Live Sales. It
-- has never reached the P&L, which reads financial_events_cache for fees. That
-- is the gap InventoryLab exposed as "MFN Shipping Label Cost" ($1,148.26 for
-- 2026) with no counterpart here.
--
-- So this RPC reads sales_orders, exactly as get_monthly_cogs does, and for
-- the same reason: the number is per-order, not per-financial-event.
--
-- ── WHY THE CRON WINDOW CHANGES FROM 7 DAYS TO 45 ─────────────────────────
--
-- poll-fbm-label-costs only ever considered orders younger than 7 days, which
-- contradicted its own lookup chain: Merchant Fulfillment answers in minutes,
-- but Finances-by-order arrives "hours-to-days later" and the range scan later
-- still. An order that had not resolved inside a week was abandoned before its
-- own fallbacks could deliver.
--
-- Measured 2026-08-31. Before: 54 orders carried a label fee, $425.20 total,
-- and Feb-Apr held nothing at all. Running the poller once with windowDays=240
-- resolved 22 of 23 candidates; resetting the 7 orders that had hit the
-- 60-attempt cap and running again resolved 3 more. After: 64 of 69 MFN orders
-- resolved, $674.94 -- $249.74 recovered, all of it data Amazon had held the
-- whole time.
--
-- 45 days is chosen to sit well past the Finances posting lag while still
-- bounding the scan. The five orders that remain unresolved were asked for
-- repeatedly across 240 days and returned nothing at every stage; they are not
-- recoverable and a wider window would only burn quota.
--
-- January is deliberately NOT chased: the seller had zero MFN orders that
-- month against InventoryLab's $113.72, so that line is measuring something
-- other than per-order FBM labels.

CREATE OR REPLACE FUNCTION public.get_monthly_fbm_label_cost(
  p_year integer,
  p_marketplace text
)
RETURNS TABLE(month_num integer, label_cost numeric, orders_with_label bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT
      EXTRACT(MONTH FROM s.order_date)::int AS m,
      ABS(COALESCE(s.shipping_label_fee, 0)) AS fee
    FROM public.sales_orders s
    WHERE s.user_id = auth.uid()
      AND s.order_date >= make_date(p_year, 1, 1)
      AND s.order_date <  make_date(p_year + 1, 1, 1)
      -- Same exclusions as get_monthly_cogs. A cancelled order's label is
      -- refunded, and a -REFUND row is a duplicate of an order already counted.
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND COALESCE(s.shipping_label_fee, 0) <> 0
      AND (
        NULLIF(UPPER(COALESCE(p_marketplace,'')),'') IS NULL
        OR UPPER(p_marketplace) = 'ALL'
        OR (UPPER(p_marketplace) = 'US' AND (s.marketplace IS NULL OR UPPER(s.marketplace) IN ('US','UNKNOWN')))
        OR (UPPER(p_marketplace) <> 'US' AND UPPER(COALESCE(s.marketplace,'')) = UPPER(p_marketplace))
      )
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(SUM(b.fee), 0) AS label_cost,
    COUNT(b.fee) AS orders_with_label
  FROM months
  LEFT JOIN base b ON b.m = months.m
  GROUP BY months.m
  ORDER BY months.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_fbm_label_cost(integer, text) TO authenticated, service_role;

-- Widen the poller's window. Body is otherwise identical to 20260601155559 --
-- same URL, same apikey-only headers (the function runs verify_jwt = false, so
-- no Authorization bearer is needed and adding one would be cargo cult).
SELECT cron.unschedule('poll-fbm-label-costs-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'poll-fbm-label-costs-30min');

SELECT cron.schedule(
  'poll-fbm-label-costs-30min',
  '*/30 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/poll-fbm-label-costs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('triggered_by', 'cron', 'windowDays', 45),
    timeout_milliseconds := 300000
  ) AS request_id;
  $cron$
);

DO $$
DECLARE v_total NUMERIC; v_orders BIGINT;
BEGIN
  SELECT COALESCE(SUM(ABS(COALESCE(shipping_label_fee, 0))), 0),
         COUNT(*) FILTER (WHERE COALESCE(shipping_label_fee, 0) <> 0)
    INTO v_total, v_orders
    FROM public.sales_orders
   WHERE order_date >= make_date(EXTRACT(YEAR FROM now())::int, 1, 1);
  RAISE NOTICE 'get_monthly_fbm_label_cost created. % across % order(s) this year.',
    to_char(v_total, 'FM999,999,990.00'), v_orders;
  RAISE NOTICE 'Cron poll-fbm-label-costs-30min now uses windowDays=45 (was an implicit 7).';
END $$;
