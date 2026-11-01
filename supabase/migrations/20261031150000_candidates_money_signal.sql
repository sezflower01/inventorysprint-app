-- STEP 2 OF THE APPROVED PLAN: detect collapsed orders by Amazon's MONEY,
-- not by the FBA-fee ratio.
--
-- ── WHY THE FEE RATIO CANNOT WORK ─────────────────────────────────────
--
-- The old predicate was:
--     AND s.quantity = 1
--     AND abs(s.fba_fee / p.unit_fee - round(...)) <= 0.08
--     AND round(s.fba_fee / p.unit_fee) >= 2
--
-- Measured 2026-10-31 against 283 confirmed collapsed 2026 orders:
--   * quantity = 1 excluded 68 of them outright (1,806.71 of COGS)
--   * the fee ratio then fired on 0 of the remaining 215
--
-- The reason is structural rather than a matter of tuning: the collapse
-- overwrote the FEE as well as the quantity. Our stored fba_fee is 15-60 pct of
-- Amazon's on 239 of the 283 orders, so the ratio sits between 1 and 2 and
-- never lands on a whole multiple >= 2. The same write that creates the defect
-- destroys the signal it was being detected by. The sweep's own header already
-- recorded the consequence -- 23 consecutive runs, 1,149 SP-API calls, 0
-- repairs.
--
-- ── THE REPLACEMENT SIGNAL ────────────────────────────────────────────
--
-- Amazon posts the money for every unit it ships. financial_events_cache
-- already holds it, so for a single-line order:
--
--     implied units = SUM(shipment sales for the order) / our unit sold_price
--
-- On the worked case 112-5072820-4704241 that is 165.00 / 15.00 = 11 against a
-- stored quantity of 2, and GetOrderItems independently says 11. No SP-API call
-- is needed to SHORTLIST, which is the whole job of this function.
--
-- ── WHAT IS DELIBERATELY EXCLUDED ─────────────────────────────────────
--
-- 1. Orders with more than one sales_orders line. money / unit price is only
--    interpretable when one ASIN accounts for all of the order's money. A
--    multi-ASIN order needs per-ASIN money, which these rows do not carry
--    (financial_events_cache.asin is NULL on them).
-- 2. Implied quantities that are NOT a whole number, to within 0.02. Nineteen
--    2026 orders fail this -- the unit price evidently differed across
--    tranches -- and a fractional implied quantity is not evidence of anything
--    specific. They are excluded here so the repair cannot touch them even by
--    accident, and are listed separately for a human to look at.
-- 3. Rows with a verdict already recorded in collapsed_order_checks, unchanged
--    from before.
--
-- ── WHAT THIS FUNCTION STILL DOES NOT DECIDE ──────────────────────────
--
-- Nothing. It shortlists which orders are worth an SP-API call. Every new value
-- comes from GetOrderItems inside repair-collapsed-orders, which keeps its
-- dry-run default and its currency gate. The money signal is strong evidence;
-- GetOrderItems is the authority. That division is the reason the old heuristic
-- being wrong corrupted nothing.
--
-- Signature and RETURNS TABLE are unchanged, so repair-collapsed-orders needs
-- no edit and CREATE OR REPLACE is enough.

CREATE OR REPLACE FUNCTION public.collapsed_order_candidates(
  p_user_id uuid,
  p_limit integer DEFAULT 25,
  p_marketplace text DEFAULT NULL,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  order_id text,
  asin text,
  marketplace text,
  quantity integer,
  sold_price numeric,
  total_sale_amount numeric,
  unit_cost numeric,
  total_cost numeric,
  referral_fee numeric,
  fba_fee numeric,
  total_fees numeric,
  order_date date,
  implied_units numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  -- SCOPE FLOOR. 2026 only, as approved. This is the one place to change it;
  -- moving to a later year means moving this date, and a January re-check of
  -- the previous year means moving it BACK, not removing it -- an unbounded
  -- floor would put years of settled history back on the sweep's list.
  WITH scope AS (SELECT '2026-01-01'::date AS since),
  one_line AS (
    SELECT s.order_id
    FROM public.sales_orders s, scope
    WHERE s.user_id = p_user_id
      AND s.order_date >= scope.since
      AND s.order_id NOT LIKE '%-REFUND%'
    GROUP BY s.order_id
    HAVING count(*) = 1
  ),
  amz AS (
    SELECT f.amazon_order_id AS order_id,
           sum(abs(COALESCE(f.sales,0))) AS money
    FROM public.financial_events_cache f, scope
    WHERE f.user_id = p_user_id
      AND f.event_type = 'shipment'
      AND f.amazon_order_id IS NOT NULL
      AND f.event_date >= scope.since
    GROUP BY f.amazon_order_id
  ),
  implied AS (
    SELECT s.*, (a.money / s.sold_price) AS implied_raw
    FROM public.sales_orders s
    CROSS JOIN scope
    JOIN one_line ol ON ol.order_id = s.order_id
    JOIN amz a       ON a.order_id  = s.order_id
    WHERE s.user_id = p_user_id
      AND s.order_date >= scope.since
      AND s.order_id NOT LIKE '%-REFUND%'
      AND COALESCE(s.sold_price,0) > 0
  )
  SELECT i.id, i.order_id, i.asin, COALESCE(i.marketplace,'US') AS marketplace,
         i.quantity, i.sold_price, i.total_sale_amount,
         i.unit_cost, i.total_cost, i.referral_fee, i.fba_fee, i.total_fees,
         i.order_date,
         round(i.implied_raw)::numeric AS implied_units
  FROM implied i
  WHERE i.implied_raw > COALESCE(i.quantity,0) + 0.5
    -- whole-number gate: a fractional implied quantity is not evidence
    AND abs(i.implied_raw - round(i.implied_raw)) <= 0.02
    AND COALESCE(i.order_status,'') NOT IN ('Cancelled','Canceled')
    AND (i.is_cancelled IS NULL OR i.is_cancelled = false)
    AND (p_marketplace IS NULL OR COALESCE(i.marketplace,'US') = p_marketplace)
    AND NOT EXISTS (
      SELECT 1 FROM public.collapsed_order_checks c WHERE c.sales_order_id = i.id
    )
  -- Biggest gaps first, so a limited sweep spends its SP-API calls on the rows
  -- that matter most. The old ordering was newest-first, which on a backlog
  -- meant the cheapest rows were checked first.
  ORDER BY (i.implied_raw - COALESCE(i.quantity,0)) DESC, i.id
  LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0), 0);
$fn$;

REVOKE ALL ON FUNCTION public.collapsed_order_candidates(uuid, integer, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collapsed_order_candidates(uuid, integer, text, integer) TO service_role;

COMMENT ON FUNCTION public.collapsed_order_candidates(uuid, integer, text, integer) IS
  'Shortlists same-ASIN-collapsed sales_orders rows using Amazon posted money / unit sold_price (2026+). Replaced the FBA-fee-ratio heuristic 2026-10-31, which fired on 0 of 283 confirmed cases. Shortlist only -- GetOrderItems decides every value.';

-- ── VERIFICATION ──────────────────────────────────────────────────────
DO $p$
DECLARE v_uid uuid; v_n int; v_us int; v_nonus int; v_units numeric; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*), sum(implied_units - quantity)
    INTO v_n, v_units
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);
  RAISE NOTICE '== candidates under the new signal: % (expected ~283) ==', v_n;
  RAISE NOTICE '   units they would add: %', COALESCE(v_units,0);

  SELECT count(*) INTO v_us FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0)
   WHERE upper(marketplace) IN ('US','UNKNOWN');
  v_nonus := v_n - v_us;
  RAISE NOTICE '   US / UNKNOWN: % | non-US: %', v_us, v_nonus;
  IF v_nonus > 0 THEN
    RAISE NOTICE '   the measurement on 20261031140000 was US/UNKNOWN only, so the';
    RAISE NOTICE '   non-US rows are NEW to the shortlist. BR/CA/MX money and';
    RAISE NOTICE '   sold_price agree at ratios 1.0000/1.0034/0.9992, so the';
    RAISE NOTICE '   predicate is valid there, and the repair has its own';
    RAISE NOTICE '   currency gate for the revenue half.';
    FOR r IN
      SELECT marketplace AS mp, count(*) AS n, sum(implied_units - quantity) AS u
      FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0)
      WHERE upper(marketplace) NOT IN ('US','UNKNOWN')
      GROUP BY 1 ORDER BY 2 DESC
    LOOP RAISE NOTICE '      % | % orders | % units', rpad(r.mp,6), r.n, r.u; END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the old signal, for comparison (fee ratio + quantity = 1) ==';
  SELECT count(*) INTO v_n FROM public.sales_orders s
  WHERE s.user_id = v_uid AND s.quantity = 1
    AND s.order_date >= '2026-01-01'
    AND EXISTS (
      SELECT 1 FROM (
        SELECT asin, percentile_cont(0.5) WITHIN GROUP (ORDER BY fba_fee / NULLIF(quantity,0)) AS uf
        FROM public.sales_orders WHERE user_id = v_uid
          AND COALESCE(fba_fee,0) > 0 AND COALESCE(quantity,0) > 0
        GROUP BY asin HAVING count(*) >= 3) p
      WHERE p.asin = s.asin AND p.uf > 0
        AND abs(s.fba_fee / p.uf - round((s.fba_fee / p.uf)::numeric)) <= 0.08
        AND round((s.fba_fee / p.uf)::numeric) >= 2);
  RAISE NOTICE '   fee-ratio candidates in 2026: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== the 19 EXCLUDED non-whole-number orders (do not touch) ==';
  RAISE NOTICE '   order               | date       | asin         | stored | implied raw';
  FOR r IN
    WITH one_line AS (
      SELECT order_id FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2026-01-01'
        AND order_id NOT LIKE '%-REFUND%'
      GROUP BY order_id HAVING count(*) = 1),
    amz AS (
      SELECT amazon_order_id AS order_id, sum(abs(COALESCE(sales,0))) AS money
      FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type = 'shipment'
        AND amazon_order_id IS NOT NULL AND event_date >= '2026-01-01'
      GROUP BY 1)
    SELECT s.order_id, s.order_date, s.asin, s.quantity AS stored,
           round((a.money / s.sold_price)::numeric, 3) AS raw,
           COALESCE(s.marketplace,'US') AS mp
    FROM public.sales_orders s
    JOIN one_line ol ON ol.order_id = s.order_id
    JOIN amz a       ON a.order_id  = s.order_id
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.order_id NOT LIKE '%-REFUND%'
      AND COALESCE(s.sold_price,0) > 0
      AND (a.money / s.sold_price) > COALESCE(s.quantity,0) + 0.5
      AND abs(a.money / s.sold_price - round((a.money / s.sold_price)::numeric)) > 0.02
      AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
    ORDER BY s.order_date
  LOOP
    RAISE NOTICE '   % | % | % | % | % (%)', r.order_id, r.order_date,
      rpad(r.asin,12), lpad(r.stored::text,6), lpad(r.raw::text,11), r.mp;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   Detection only. No SP-API call, no row written.';
END
$p$;
