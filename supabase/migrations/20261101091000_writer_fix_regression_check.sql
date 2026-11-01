-- DID THE WRITER FIX HOLD? -- READ ONLY. No Amazon call.
--
-- The fix deployed to fetch-live-orders at 2026-10-31 19:55 CDT = 2026-11-01
-- 00:55 UTC (commit d42e76d). Any order FIRST INGESTED after that which still
-- shows up as a collapse candidate means the merge missed a path.
--
-- ── WHAT THIS CHECK CAN AND CANNOT PROVE ──────────────────────────────
--
-- Stated before the result, so a convenient answer cannot be dressed up later:
--
--   * the sync reads only yesterday and today, so only recent orders are in
--     scope at all;
--   * only an order carrying TWO OrderItems for the SAME ASIN can exhibit the
--     bug, which was historically ~1-2 pct of orders;
--   * therefore a quiet night produces few or no qualifying orders, and "zero
--     new collapsed orders" would be true but nearly meaningless.
--
-- So the denominator is reported first: how many orders arrived since the
-- deploy. Without that number the zero is not evidence.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_cut timestamptz := '2026-11-01 00:55:00+00';
  v_new int; v_new_cand int; v_old_cand int; v_total_cand int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. THE DENOMINATOR: what arrived since the deploy ############';
  SELECT count(*) INTO v_new
  FROM public.sales_orders
  WHERE user_id = v_uid AND created_at >= v_cut
    AND order_id NOT LIKE '%-REFUND%';
  RAISE NOTICE '   sales_orders rows created since % : %', v_cut, v_new;

  FOR r IN
    SELECT count(DISTINCT order_id) AS orders,
           sum(COALESCE(quantity,0)) AS units,
           min(created_at) AS first_in, max(created_at) AS last_in
    FROM public.sales_orders
    WHERE user_id = v_uid AND created_at >= v_cut
      AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   distinct orders % | units % | % .. %',
      r.orders, COALESCE(r.units,0), r.first_in, r.last_in;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   of those, how many have MORE THAN ONE sales_orders line?';
  RAISE NOTICE '   (a multi-line order is the only shape that can collapse)';
  FOR r IN
    SELECT count(*) AS multi
    FROM (
      SELECT order_id FROM public.sales_orders
      WHERE user_id = v_uid AND created_at >= v_cut
        AND order_id NOT LIKE '%-REFUND%'
      GROUP BY order_id HAVING count(*) > 1) x
  LOOP RAISE NOTICE '      multi-line orders since the deploy: %', r.multi; END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. ARE ANY OF THEM COLLAPSED? ############';
  SELECT count(*) INTO v_total_cand
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);

  SELECT count(*) INTO v_new_cand
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0) c
  JOIN public.sales_orders s
    ON s.user_id = v_uid AND s.order_id = c.order_id AND s.asin = c.asin
  WHERE s.created_at >= v_cut;
  v_old_cand := v_total_cand - v_new_cand;

  RAISE NOTICE '   candidates in total            : %', v_total_cand;
  RAISE NOTICE '   ingested BEFORE the deploy     : % (the known backlog)', v_old_cand;
  RAISE NOTICE '   ingested AFTER the deploy      : % <= must be 0', v_new_cand;

  IF v_new_cand > 0 THEN
    RAISE NOTICE '   >>> REGRESSION. The merge missed a path. The rows:';
    FOR r IN
      SELECT c.order_id, c.asin, c.quantity, c.implied_units, s.created_at
      FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0) c
      JOIN public.sales_orders s
        ON s.user_id = v_uid AND s.order_id = c.order_id AND s.asin = c.asin
      WHERE s.created_at >= v_cut
      ORDER BY s.created_at
    LOOP
      RAISE NOTICE '      % | % | stored % | implies % | created %',
        r.order_id, rpad(r.asin,12), r.quantity, r.implied_units, r.created_at;
    END LOOP;
  ELSE
    RAISE NOTICE '   >>> no new collapsed order. Now the honest caveat:';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. HOW MUCH IS THAT WORTH? ############';
  IF v_new = 0 THEN
    RAISE NOTICE '   NOTHING. Zero orders were ingested since the deploy, so the';
    RAISE NOTICE '   check had no input and proves nothing at all. The writer fix';
    RAISE NOTICE '   remains deployed but UNPROVEN.';
  ELSE
    RAISE NOTICE '   % orders arrived. Historically ~1-2 pct of orders carry two', v_new;
    RAISE NOTICE '   lines of one ASIN, so the expected number of NEW collapses';
    RAISE NOTICE '   under the OLD writer would have been roughly % to %.',
      round(v_new * 0.01, 1), round(v_new * 0.02, 1);
    IF v_new < 50 THEN
      RAISE NOTICE '   That is below 1 expected case, so a zero here is consistent';
      RAISE NOTICE '   with the fix working AND with it not working. WEAK evidence.';
    ELSE
      RAISE NOTICE '   That is at least one expected case, so a zero starts to be';
      RAISE NOTICE '   real evidence -- still thin, but not vacuous.';
    END IF;
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. DID THE MERGE ACTUALLY RUN? ############';
  RAISE NOTICE '   The function logs COLLAPSE_PREVENTED whenever it folds a';
  RAISE NOTICE '   repeated ASIN line. That log is the direct positive evidence,';
  RAISE NOTICE '   and it lives in the edge-function logs, not in any table --';
  RAISE NOTICE '   check it in the Supabase dashboard for fetch-live-orders.';
  RAISE NOTICE '   Absence of the log plus zero new candidates means "no';
  RAISE NOTICE '   qualifying order arrived", NOT "the fix works".';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, no API called.';
END
$p$;
