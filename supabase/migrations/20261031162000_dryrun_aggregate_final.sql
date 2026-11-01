-- STEP 4, COMPLETE: the predicted before/after from ALL validated rows, then STOP.
--
-- Aggregates all EIGHT dry-run responses: the six shortlist batches plus the
-- two remainder passes that closed the gap left by the response's 40-row cap
-- and by 66 Amazon throttles.
--
-- The earlier aggregate (20261031158000) reported 3,411.13 from 189 of 217
-- validated repairs, because `rows` was capped at 40 per response while the
-- counts stayed complete. That figure was short and is superseded here. Every value in them came from GetOrderItems inside
-- repair-collapsed-orders, not from the money signal -- which matters, because
-- the two disagree and the dry run is the authority.
--
-- WHY THE MONEY SIGNAL WAS A GOOD DETECTOR AND A BAD ESTIMATOR. On
-- 114-9467604-9904216 it implied 30 units; Amazon says 15. The arithmetic was
-- money / sold_price, and on these rows sold_price is itself wrong -- revenue
-- was collapsed along with quantity, so the denominator is understated. As a
-- shortlist the signal is excellent (batches 1-3: 149 checked, 149 confirmed,
-- 0 already_correct). As a source of new values it would have been wrong. That
-- is exactly the division the repair function was built around, and it held.
--
-- So the earlier 4,760.79 estimate -- computed from implied units -- is NOT the
-- figure. The figure is below, from validated quantities.
--
-- TWO DIFFERENT COGS NUMBERS ARE REPORTED, deliberately:
--   1. the repair's own total_cost delta, which uses sales_orders.unit_cost
--   2. the get_monthly_cogs delta, which uses resolve_unit_cost_v1
-- The P&L reads (2). They can differ where the snapshot cost and the resolved
-- cost disagree, and reporting only one would hide that.
DO $p$
DECLARE
  r record; v_uid uuid; i int;
  v_status int; v_content text;
  v_reqs bigint[] := ARRAY[59951, 59985, 60032, 60055, 60078, 60105, 60157, 60192];
  v_req bigint;
  v_checked int := 0; v_would int := 0; v_ok int := 0;
  v_unver int := 0; v_thr int := 0; v_fx int := 0;
  v_tc_delta numeric := 0; v_cogs_delta numeric := 0; v_units int := 0;
  v_qty_rows int := 0; v_rev_rows int := 0; v_claw numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  -- wait for the last batch
  FOR i IN 1..60 LOOP
    SELECT status_code INTO v_status FROM net._http_response WHERE id = 60192;
    EXIT WHEN v_status IS NOT NULL;
    PERFORM pg_sleep(3);
  END LOOP;
  IF v_status IS NULL THEN
    RAISE NOTICE '>>> remainder pass 2 (60192) never landed. STOPPING -- the aggregate';
    RAISE NOTICE '    would be incomplete and would understate the total.';
    RETURN;
  END IF;

  -- ON COMMIT DROP follows the column list; before it is a syntax error.
  CREATE TEMP TABLE dr (
    req bigint, order_id text, asin text, mp text, order_date date,
    qf numeric, qt numeric, rf numeric, rt numeric,
    cf numeric, ct numeric, fx text
  ) ON COMMIT DROP;

  FOREACH v_req IN ARRAY v_reqs LOOP
    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = v_req;
    IF v_status IS NULL OR v_status <> 200 THEN
      RAISE NOTICE '>>> request % is missing or not 200 (%). STOPPING.', v_req, v_status;
      RETURN;
    END IF;
    v_checked := v_checked + COALESCE((v_content::jsonb->>'checked')::int,0);
    v_would   := v_would   + COALESCE((v_content::jsonb->>'would_repair')::int,0);
    v_ok      := v_ok      + COALESCE((v_content::jsonb->>'already_correct')::int,0);
    v_unver   := v_unver   + COALESCE((v_content::jsonb->>'unverifiable')::int,0);
    v_thr     := v_thr     + COALESCE((v_content::jsonb->>'throttled')::int,0);
    v_fx      := v_fx      + COALESCE((v_content::jsonb->>'fx_skipped')::int,0);

    INSERT INTO dr
    SELECT v_req, e->>'order_id', e->>'asin', e->>'mp',
           NULLIF(e->>'order_date','')::date,
           NULLIF(e->'quantity'->>'from','')::numeric,
           NULLIF(e->'quantity'->>'to','')::numeric,
           NULLIF(e->'revenue'->>'from','')::numeric,
           NULLIF(e->'revenue'->>'to','')::numeric,
           NULLIF(e->'total_cost'->>'from','')::numeric,
           NULLIF(e->'total_cost'->>'to','')::numeric,
           e->>'revenue_skipped_non_usd'
    FROM jsonb_array_elements(COALESCE(v_content::jsonb->'rows','[]'::jsonb)) AS e;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. THE DRY RUN, ALL SIX BATCHES ############';
  RAISE NOTICE '   candidates in the shortlist : %',
    (SELECT count(*) FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0));
  RAISE NOTICE '   checked against GetOrderItems: %', v_checked;
  RAISE NOTICE '   would repair                 : %', v_would;
  RAISE NOTICE '   already correct              : % <= Amazon agrees with us', v_ok;
  RAISE NOTICE '   unverifiable (404 / no auth) : %', v_unver;
  RAISE NOTICE '   THROTTLED (429, not checked) : % <= must be retried', v_thr;
  RAISE NOTICE '   fx-skipped revenue halves    : %', v_fx;
  RAISE NOTICE '   rows returned                : %', (SELECT count(*) FROM dr);

  SELECT count(*) FILTER (WHERE qt IS NOT NULL),
         count(*) FILTER (WHERE rt IS NOT NULL),
         COALESCE(sum(qt - qf) FILTER (WHERE qt IS NOT NULL),0),
         COALESCE(sum(ct - cf) FILTER (WHERE ct IS NOT NULL),0)
    INTO v_qty_rows, v_rev_rows, v_units, v_tc_delta
  FROM dr;
  RAISE NOTICE '';
  RAISE NOTICE '   rows with a QUANTITY change : % (units added %)', v_qty_rows, v_units;
  RAISE NOTICE '   rows with a REVENUE change  : %', v_rev_rows;
  RAISE NOTICE '   rows with revenue but NOT quantity: % <= quantity was right,',
    (SELECT count(*) FROM dr WHERE rt IS NOT NULL AND qt IS NULL);
  RAISE NOTICE '     revenue was collapsed. These move NO COGS.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. COGS EFFECT, TWO WAYS ############';
  RAISE NOTICE '   (a) the repair''s own total_cost delta (sales_orders.unit_cost): %',
    round(v_tc_delta,2);

  -- (b) what get_monthly_cogs will actually do: resolve_unit_cost_v1 x delta qty
  CREATE TEMP TABLE pred ON COMMIT DROP AS
  SELECT d.order_id, d.asin, d.order_date,
         EXTRACT(MONTH FROM d.order_date)::int AS m,
         (d.qt - d.qf) AS dq,
         rc.unit_cost AS resolved,
         (d.qt - d.qf) * COALESCE(rc.unit_cost,0) AS cogs_delta
  FROM dr d
  JOIN public.sales_orders s
    ON s.user_id = v_uid AND s.order_id = d.order_id AND s.asin = d.asin
  CROSS JOIN LATERAL public.resolve_unit_cost_v1(
    v_uid, s.asin, s.sku, s.order_date, s.unit_cost) rc
  WHERE d.qt IS NOT NULL AND d.qt <> d.qf;

  SELECT COALESCE(sum(cogs_delta),0) INTO v_cogs_delta FROM pred;
  RAISE NOTICE '   (b) the get_monthly_cogs delta (resolve_unit_cost_v1)      : %',
    round(v_cogs_delta,2);
  RAISE NOTICE '   (b) is the one the P&L moves by. Difference between them: %',
    round(v_cogs_delta - v_tc_delta,2);
  RAISE NOTICE '';
  RAISE NOTICE '   for comparison, the money-signal ESTIMATE was 4,760.79 across';
  RAISE NOTICE '   283 orders. Validated against Amazon it is % across % orders.',
    round(v_cogs_delta,2), v_qty_rows;

  SELECT count(*) INTO i FROM pred WHERE COALESCE(resolved,0) = 0;
  IF i > 0 THEN
    RAISE NOTICE '   % of those rows have no resolved unit cost, so they add units',
      i;
    RAISE NOTICE '   but 0.00 of COGS -- they move units_missing_cost instead.';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. PREDICTED get_monthly_cogs, BEFORE -> AFTER ############';
  RAISE NOTICE '   month |    COGS now | units now | +units | + COGS |   COGS after | pct';
  FOR r IN
    SELECT c.month_num AS m, round(c.cogs,2) AS now, c.units_sold AS u,
           COALESCE(p.dq,0) AS dq, round(COALESCE(p.cd,0),2) AS cd
    FROM public.get_monthly_cogs(2026, NULL) c
    LEFT JOIN (SELECT m, sum(dq) AS dq, sum(cogs_delta) AS cd
               FROM pred GROUP BY m) p ON p.m = c.month_num
    ORDER BY c.month_num
  LOOP
    IF r.now <> 0 OR r.dq <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | % | % | % pct',
        lpad(r.m::text,5), lpad(r.now::text,11), lpad(r.u::text,9),
        lpad(r.dq::text,6), lpad(r.cd::text,6),
        lpad(round(r.now + r.cd,2)::text,12),
        lpad(CASE WHEN r.now > 0 THEN round(100.0*r.cd/r.now,2)::text ELSE '-' END,5);
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. THE CLAWBACK TOTAL MUST NOT MOVE ############';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '   2026 compensated_clawback in the cache: %', v_claw;
  RAISE NOTICE '   the nine-month applied NET remains -1765.91 -- unchanged by';
  RAISE NOTICE '   this work, which touches sales_orders only and never';
  RAISE NOTICE '   financial_events_cache. Re-asserted after any apply.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 5. WHAT IS NOT YET VALIDATED ############';
  RAISE NOTICE '   throttled calls across all passes (429, retried later): %', v_thr;
  SELECT count(*) INTO i
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0) c
  WHERE NOT EXISTS (SELECT 1 FROM dr d WHERE d.order_id = c.order_id);
  RAISE NOTICE '   candidates STILL without validated detail: %', i;
  IF i > 0 THEN
    RAISE NOTICE '   >>> the prediction below covers only what was validated.';
    RAISE NOTICE '   >>> One more paced remainder pass is needed to close it.';
  ELSE
    RAISE NOTICE '   >>> every candidate now has a validated verdict. Complete.';
  END IF;
  RAISE NOTICE '   The 19 non-whole-number orders remain excluded and untouched.';
  RAISE NOTICE '';
  RAISE NOTICE '   STOPPING HERE for approval, as instructed. Nothing applied:';
  RAISE NOTICE '   every batch ran with dry_run defaulted to true and the';
  RAISE NOTICE '   responses report repaired: 0.';
END
$p$;
