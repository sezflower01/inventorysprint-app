-- TODAY'S FIGURES FOR THE APPROVAL DECISION -- READ ONLY. No Amazon call.
--
-- Three things, all as of now rather than yesterday (October keeps posting, so
-- its COGS row moves):
--   1. get_monthly_cogs before/after per month, in dollars
--   2. the 19 excluded non-whole-number orders
--   3. the clawback total, which must stay -1,765.91
--
-- ── WHICH "AFTER" IS THIS? AN UPPER BOUND, AND SAID SO PLAINLY ────────
--
-- The per-month delta here comes from the MONEY SIGNAL (Amazon's posted money /
-- our unit price), because yesterday's GetOrderItems-validated detail was lost
-- when pg_net pruned its responses at the 6-hour mark.
--
-- The money signal is a proven DETECTOR -- 448 checks yesterday, 275
-- would_repair, 0 already_correct, not one false positive -- but a measurably
-- biased ESTIMATOR: on the subset that was validated it implied more units than
-- Amazon confirmed, 4,760.79 against 4,085.44, about 16 pct high. The cause is
-- known: the denominator (sold_price) was collapsed along with the quantity, so
-- dividing by it overstates the count.
--
-- So every "after" below is a CEILING. The validated outcome will land lower,
-- and the apply itself reports the true figure because it writes only what
-- GetOrderItems confirms.
DO $p$
DECLARE
  r record; v_uid uuid; v_claw numeric; v_now numeric := 0; v_after numeric := 0;
  v_units int := 0; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  CREATE TEMP TABLE cand ON COMMIT DROP AS
  SELECT c.order_id, c.asin, c.quantity AS stored, c.implied_units AS implied,
         s.order_date, EXTRACT(MONTH FROM s.order_date)::int AS m,
         (c.implied_units - c.quantity) AS dq,
         rc.unit_cost AS resolved,
         (c.implied_units - c.quantity) * COALESCE(rc.unit_cost,0) AS cogs_delta
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0) c
  JOIN public.sales_orders s
    ON s.user_id = v_uid AND s.order_id = c.order_id AND s.asin = c.asin
  CROSS JOIN LATERAL public.resolve_unit_cost_v1(
    v_uid, s.asin, s.sku, s.order_date, s.unit_cost) rc;

  SELECT count(*) INTO v_n FROM cand;
  RAISE NOTICE '############ 1. get_monthly_cogs, BEFORE -> CEILING ############';
  RAISE NOTICE '   from % candidates. Every "after" is an UPPER BOUND.', v_n;
  RAISE NOTICE '   month |      COGS now | +units |    +COGS |   ceiling | pct';
  FOR r IN
    SELECT c.month_num AS m, round(c.cogs,2) AS nowc, c.units_sold AS u,
           COALESCE(x.dq,0) AS dq, round(COALESCE(x.cd,0),2) AS cd
    FROM public.get_monthly_cogs(2026, NULL) c
    LEFT JOIN (SELECT m, sum(dq) AS dq, sum(cogs_delta) AS cd
               FROM cand GROUP BY m) x ON x.m = c.month_num
    ORDER BY c.month_num
  LOOP
    IF r.nowc <> 0 OR r.dq <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | % | % pct',
        lpad(r.m::text,5), lpad(r.nowc::text,13), lpad(r.dq::text,6),
        lpad(r.cd::text,8), lpad(round(r.nowc + r.cd,2)::text,9),
        lpad(CASE WHEN r.nowc > 0 THEN round(100.0*r.cd/r.nowc,2)::text
             ELSE '-' END,5);
      v_now := v_now + r.nowc;
      v_after := v_after + r.nowc + r.cd;
      v_units := v_units + r.dq;
    END IF;
  END LOOP;
  RAISE NOTICE '   ------------------------------------------------------------';
  RAISE NOTICE '   2026  | % | % | % | % |',
    lpad(round(v_now,2)::text,13), lpad(v_units::text,6),
    lpad(round(v_after - v_now,2)::text,8), lpad(round(v_after,2)::text,9);
  RAISE NOTICE '';
  RAISE NOTICE '   ceiling on the COGS increase : %', round(v_after - v_now,2);
  RAISE NOTICE '   validated yesterday on 247/285: 4085.44 (236 orders, 503 units)';
  RAISE NOTICE '   expect the real figure near the lower number, not the ceiling.';
  RAISE NOTICE '   net profit falls by whatever COGS rises by.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. THE 19 EXCLUDED ORDERS -- untouched ############';
  RAISE NOTICE '   the whole-number gate lives INSIDE collapsed_order_candidates,';
  RAISE NOTICE '   so no apply can reach these even by mistake.';
  RAISE NOTICE '   order               | date       | asin         | stored | implies';
  v_n := 0;
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
           round((a.money / s.sold_price)::numeric, 3) AS raw
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
    v_n := v_n + 1;
    RAISE NOTICE '   % | % | % | % | %', r.order_id, r.order_date,
      rpad(r.asin,12), lpad(r.stored::text,6), lpad(r.raw::text,7);
  END LOOP;
  RAISE NOTICE '   total excluded: %', v_n;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. THE CLAWBACK TOTAL ############';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '   2026 compensated_clawback in the cache : %', v_claw;
  RAISE NOTICE '   nine-month applied NET                 : -1765.91';
  RAISE NOTICE '   This work touches sales_orders ONLY. financial_events_cache,';
  RAISE NOTICE '   where every clawback figure lives, is never written by it --';
  RAISE NOTICE '   so the total cannot move. Re-asserted after any apply.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, no API called.';
END
$p$;
