-- ONE rule for counting returned units, used by both surfaces.
--
-- The previous migration fixed the view's denominator and broke its numerator.
-- It clamped a "-REFUND" row to that row's OWN quantity, which is often a
-- placeholder of 1 while refund_quantity carries the real count -- so
-- B0CKJNCZLY fell to 57 returns (11.4%) where get_asin_profit says 99 (19.8%).
-- Fixing one disagreement by creating another is not progress.
--
-- The rule, stated once:
--
--   a return cannot exceed the units its ORDER shipped.
--
-- For a parent order that is its own quantity. For a "-REFUND" row it is the
-- PARENT order's quantity, which is the thing being refunded -- not the refund
-- row's own quantity, which is unreliable, and not refund_quantity unchecked,
-- which is where the phantoms live (48 rows, 671 units, one claiming 40 units
-- returned against an order that sold 1).
--
-- Expressed as: LEAST(COALESCE(NULLIF(refund_quantity,0), quantity), parent_quantity)
-- with parent_quantity falling back to the row's own quantity when no parent is
-- found, so an orphaned refund row still counts something rather than vanishing.
--
-- Both the view and the function are rewritten here together, in one migration,
-- deliberately: they are read side by side -- the extension shows one and the
-- Sales Report the other -- and a seller comparing two screens is exactly who
-- notices drift. Change this rule in one place only and that is the bug.

-- ─────────────────────────────── the view ───────────────────────────────
CREATE OR REPLACE VIEW public.asin_return_stats
WITH (security_invoker = true) AS
WITH base AS (
  SELECT
    o.user_id, o.asin, o.order_date, o.order_id, o.quantity,
    (o.order_id LIKE '%-REFUND') AS is_refund_row,
    (COALESCE(o.sold_price, 0) <= 0 AND o.order_id NOT LIKE '%-REFUND') AS zero_priced,
    COALESCE(o.refund_quantity, 0) AS refund_quantity,
    -- the order being refunded, for refund rows
    COALESCE((
      SELECT p.quantity FROM public.sales_orders p
      WHERE p.user_id = o.user_id
        AND p.order_id = replace(o.order_id, '-REFUND', '')
      LIMIT 1
    ), o.quantity) AS parent_quantity
  FROM public.sales_orders o
  WHERE COALESCE(o.is_cancelled, false) = false
    AND o.asin IS NOT NULL AND o.asin <> 'UNKNOWN'
), scored AS (
  SELECT
    user_id, asin, order_date,
    CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE quantity END AS sold_units,
    CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE 1 END        AS sold_order,
    CASE
      WHEN is_refund_row
        THEN LEAST(COALESCE(NULLIF(refund_quantity, 0), quantity), parent_quantity)
      ELSE LEAST(refund_quantity, quantity)
    END AS returned_units
  FROM base
)
SELECT
  user_id, asin,
  sum(sold_units)::int AS units_sold,
  sum(returned_units)::int AS units_returned,
  count(*) FILTER (WHERE returned_units > 0)::int AS orders_returned,
  sum(sold_order)::int AS orders_total,
  round(100.0 * sum(returned_units) / NULLIF(sum(sold_units), 0), 1) AS return_rate_pct,
  max(order_date) FILTER (WHERE returned_units > 0) AS last_return_date,
  min(order_date) FILTER (WHERE sold_units > 0) AS first_sale_date,
  max(order_date) FILTER (WHERE sold_units > 0) AS last_sale_date,
  sum(sold_units) FILTER (WHERE order_date >= current_date - 365)::int AS units_sold_12m,
  sum(returned_units) FILTER (WHERE order_date >= current_date - 365)::int AS units_returned_12m
FROM scored
GROUP BY user_id, asin;

REVOKE ALL ON public.asin_return_stats FROM PUBLIC, anon;
GRANT SELECT ON public.asin_return_stats TO authenticated;

COMMENT ON VIEW public.asin_return_stats IS
  'Per-ASIN return history. Counting rule shared with get_asin_profit: a return cannot exceed the units its ORDER shipped (for a -REFUND row that means the PARENT order quantity), -REFUND and zero-priced rows are not sales. Change the rule in both or neither.';

-- ──────────────────────────── and the function ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_asin_profit(
  p_asin text, p_start date, p_end date
)
RETURNS TABLE (
  asin text, units_sold integer, orders integer, revenue numeric, fees numeric,
  label_fees numeric, cogs numeric, gross_profit numeric, gross_per_unit numeric,
  gross_roi_pct numeric, units_returned integer, return_rate_pct numeric,
  return_cost numeric, net_profit numeric, net_per_unit numeric, net_roi_pct numeric,
  net_if_written_off numeric, roi_if_written_off numeric, avg_sale_price numeric,
  avg_unit_cost numeric, excluded_zero_rows integer, excluded_zero_fees numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_asin text := upper(btrim(p_asin));
  v_ret_total int;
  v_fba_unit numeric; v_referral_unit numeric; v_admin numeric; v_cog_record numeric;
BEGIN
  IF v_uid IS NULL OR v_asin = '' THEN RETURN; END IF;

  -- THE shared rule: a return cannot exceed the units its order shipped.
  SELECT COALESCE(sum(
           CASE WHEN s.order_id LIKE '%-REFUND'
                THEN LEAST(COALESCE(NULLIF(s.refund_quantity, 0), s.quantity),
                           COALESCE((SELECT p.quantity FROM sales_orders p
                                     WHERE p.user_id = s.user_id
                                       AND p.order_id = replace(s.order_id, '-REFUND', '')
                                     LIMIT 1), s.quantity))
                ELSE LEAST(COALESCE(s.refund_quantity, 0), s.quantity)
           END), 0)
    INTO v_ret_total
  FROM sales_orders s
  WHERE s.user_id = v_uid AND s.asin = v_asin
    AND s.order_date >= p_start AND s.order_date <= p_end
    AND COALESCE(s.is_cancelled, false) = false;

  SELECT COALESCE(avg(s.fba_fee / NULLIF(s.quantity, 0)), 0),
         COALESCE(avg(s.referral_fee / NULLIF(s.quantity, 0)), 0)
    INTO v_fba_unit, v_referral_unit
  FROM sales_orders s
  WHERE s.user_id = v_uid AND s.asin = v_asin
    AND s.order_date >= p_start AND s.order_date <= p_end
    AND COALESCE(s.is_cancelled, false) = false
    AND s.order_id NOT LIKE '%-REFUND'
    AND COALESCE(s.fba_fee, 0) > 0;

  v_admin := LEAST(5.00, 0.20 * v_referral_unit);

  SELECT c.unit_cost INTO v_cog_record FROM asin_cog_for_repricer c
  WHERE c.user_id = v_uid AND c.asin = v_asin;

  RETURN QUERY
  WITH clean AS (
    SELECT s.quantity,
           COALESCE(s.total_sale_amount, s.sold_price * s.quantity) AS rev,
           COALESCE(s.total_fees, 0) AS fee,
           COALESCE(s.shipping_label_fee, 0) AS label,
           COALESCE(s.unit_cost_at_sale, s.unit_cost, v_cog_record, 0) AS cost
    FROM sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND s.order_date >= p_start AND s.order_date <= p_end
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) > 0
  ), excluded AS (
    SELECT count(*)::int AS n, COALESCE(sum(COALESCE(s.total_fees, 0)), 0) AS f
    FROM sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND s.order_date >= p_start AND s.order_date <= p_end
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) <= 0
  ), agg AS (
    SELECT COALESCE(sum(c.quantity), 0)::int AS units, count(*)::int AS ord,
           COALESCE(sum(c.rev), 0) AS rev, COALESCE(sum(c.fee), 0) AS fee,
           COALESCE(sum(c.label), 0) AS label, COALESCE(sum(c.cost * c.quantity), 0) AS cogs
    FROM clean c
  )
  SELECT
    v_asin, a.units, a.ord,
    round(a.rev, 2), round(a.fee, 2), round(a.label, 2), round(a.cogs, 2),
    round(a.rev - a.fee - a.label - a.cogs, 2),
    round((a.rev - a.fee - a.label - a.cogs) / NULLIF(a.units, 0), 2),
    round(100 * (a.rev - a.fee - a.label - a.cogs) / NULLIF(a.cogs, 0), 1),
    v_ret_total,
    round(100.0 * v_ret_total / NULLIF(a.units, 0), 1),
    round(v_ret_total * (v_fba_unit + v_admin), 2),
    round(a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin), 2),
    round((a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin)) / NULLIF(a.units, 0), 2),
    round(100 * (a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin)) / NULLIF(a.cogs, 0), 1),
    round(a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin)
          - v_ret_total * COALESCE(v_cog_record, a.cogs / NULLIF(a.units, 0), 0), 2),
    round(100 * (a.rev - a.fee - a.label - a.cogs - v_ret_total * (v_fba_unit + v_admin)
          - v_ret_total * COALESCE(v_cog_record, a.cogs / NULLIF(a.units, 0), 0)) / NULLIF(a.cogs, 0), 1),
    round(a.rev / NULLIF(a.units, 0), 2),
    round(a.cogs / NULLIF(a.units, 0), 2),
    e.n, round(e.f, 2)
  FROM agg a CROSS JOIN excluded e;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.get_asin_profit(text, date, date) TO authenticated;

DO $p$
DECLARE v_uid uuid; r record; v_start date;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  v_start := (date_trunc('day', current_date) - interval '12 months')::date;

  RAISE NOTICE '== the two surfaces, side by side (12 months) ==';
  FOR r IN
    SELECT v.asin,
           v.units_sold_12m AS view_sold, v.units_returned_12m AS view_ret,
           p.units_sold AS fn_sold, p.units_returned AS fn_ret,
           p.return_rate_pct AS fn_rate, p.net_profit, p.net_roi_pct
    FROM public.asin_return_stats v
    CROSS JOIN LATERAL public.get_asin_profit(v.asin, v_start, current_date) p
    WHERE v.user_id = v_uid
      AND v.asin IN ('B077DY3DRM','B0CKJNCZLY','B0CYR1KRRL','B08HGZ2HXT','B077ZYJ3TB')
    ORDER BY v.asin
  LOOP
    RAISE NOTICE '  % | view % sold / % ret | fn % sold / % ret (% pct) | net $% (% pct) | AGREE: %',
      r.asin, r.view_sold, r.view_ret, r.fn_sold, r.fn_ret, r.fn_rate,
      r.net_profit, r.net_roi_pct,
      (r.view_sold = r.fn_sold AND r.view_ret = r.fn_ret);
  END LOOP;
END
$p$;
