-- THREE DRY RUNS, READ ONLY. Nothing written.
--
--   A. who would lose a cost if new products had to wait for a shipment
--   B. backfill of the 572 already-confirmable lots
--   C. the year fix under the best-available rule
--
-- ── HOW THE COGS DELTA IS COMPUTED ───────────────────────────────────
--
-- get_monthly_cogs cannot be run "as if" a COG had changed without writing it,
-- so the movement is computed directly instead, which is exactly equivalent:
-- every 2026 sales_orders row already carries the COG write-through in
-- unit_cost, so for an ASIN whose COG would move from old to new,
--     delta = sum(quantity) * (new - old)
-- per month. That is the same arithmetic get_monthly_cogs does
-- (sum(effective_unit_cost * qty)), restricted to the rows that change.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_asins int; v_conf int; v_alloc int; v_none int;
  v_tot numeric; v_lost numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  -- shared: per-ASIN purchase evidence this year
  ------------------------------------------------------------------
  CREATE TEMP TABLE ev AS
  SELECT cl.asin,
         count(*) AS lots_all,
         sum(cl.cost) AS spent_all,
         sum(cl.units) AS units_all,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.shipment_purchase_allocations a
            JOIN public.shipment_builder_drafts d
              ON d.user_id = a.user_id AND d.draft_id = a.draft_id
           WHERE a.created_listing_id = cl.id
             AND d.continued_to_amazon_at IS NOT NULL)) AS lots_conf,
         sum(cl.cost * COALESCE((
           SELECT GREATEST(a.units_shipped, a.units_allocated)
           FROM public.shipment_purchase_allocations a
            JOIN public.shipment_builder_drafts d
              ON d.user_id = a.user_id AND d.draft_id = a.draft_id
           WHERE a.created_listing_id = cl.id
             AND d.continued_to_amazon_at IS NOT NULL
           ORDER BY GREATEST(a.units_shipped, a.units_allocated) DESC LIMIT 1),0)
           / NULLIF(cl.units,0)) AS spent_conf,
         sum(COALESCE((
           SELECT GREATEST(a.units_shipped, a.units_allocated)
           FROM public.shipment_purchase_allocations a
            JOIN public.shipment_builder_drafts d
              ON d.user_id = a.user_id AND d.draft_id = a.draft_id
           WHERE a.created_listing_id = cl.id
             AND d.continued_to_amazon_at IS NOT NULL
           ORDER BY GREATEST(a.units_shipped, a.units_allocated) DESC LIMIT 1),0)) AS units_conf,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.shipment_purchase_allocations a
           WHERE a.created_listing_id = cl.id)) AS lots_any_alloc
  FROM public.created_listings cl
  WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
    AND cl.created_at >= date_trunc('year', now())
  GROUP BY cl.asin;

  SELECT count(*), count(*) FILTER (WHERE lots_conf > 0),
         count(*) FILTER (WHERE lots_any_alloc > 0 AND lots_conf = 0),
         count(*) FILTER (WHERE lots_any_alloc = 0)
    INTO v_asins, v_conf, v_alloc, v_none FROM ev;

  RAISE NOTICE '######## A. WHO WOULD LOSE A COST ########';
  RAISE NOTICE '   ASINs purchased this year            : %', v_asins;
  RAISE NOTICE '   with >=1 shipment-confirmed lot      : %', v_conf;
  RAISE NOTICE '   allocated to a draft but not sent    : %', v_alloc;
  RAISE NOTICE '   never allocated (FBM-only or unsent) : %  <= need the fallback',
    v_none;

  -- what 2026 COGS depends on the unconfirmed ones
  SELECT round(sum(COALESCE(s.total_cost,0))::numeric,2) INTO v_tot
  FROM public.sales_orders s
  WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
    AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%';
  SELECT round(sum(COALESCE(s.total_cost,0))::numeric,2) INTO v_lost
  FROM public.sales_orders s
  JOIN ev ON ev.asin = s.asin
  WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
    AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
    AND ev.lots_conf = 0;
  RAISE NOTICE '';
  RAISE NOTICE '   2026 COGS on sales_orders            : %', COALESCE(v_tot,0);
  RAISE NOTICE '   ... belonging to UNCONFIRMED ASINs   : % (% pct)',
    COALESCE(v_lost,0), round(100.0*COALESCE(v_lost,0)/NULLIF(v_tot,0),1);
  RAISE NOTICE '   >>> that is what would vanish if an unconfirmed product';
  RAISE NOTICE '   >>> carried NO cost. Hence the labelled-unconfirmed fallback.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## B. BACKFILL DRY RUN: confirmed-only averages ########';
  CREATE TEMP TABLE chg AS
  SELECT ev.asin,
         c.unit_cost AS cog_now,
         round(ev.spent_conf / NULLIF(ev.units_conf,0), 4) AS cog_conf,
         ev.lots_conf, ev.lots_all,
         COALESCE(c.source,'(none)') AS src,
         EXISTS (SELECT 1 FROM public.asin_cost_overrides o
                  WHERE o.user_id = v_uid AND o.asin = ev.asin) AS has_override
  FROM ev
  LEFT JOIN public.asin_cog_on_record c ON c.user_id = v_uid AND c.asin = ev.asin
  WHERE ev.lots_conf > 0 AND ev.units_conf > 0;

  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE has_override OR src='manual') AS protected,
           count(*) FILTER (WHERE NOT (has_override OR src='manual')
                              AND cog_now IS NOT NULL
                              AND abs(cog_conf - cog_now) > 0.005) AS would_move,
           count(*) FILTER (WHERE NOT (has_override OR src='manual')
                              AND cog_now IS NOT NULL AND cog_now > 0
                              AND abs(cog_conf - cog_now)/cog_now > 0.25) AS over_25
    FROM chg
  LOOP
    RAISE NOTICE '   ASINs with confirmed lots   : %', r.n;
    RAISE NOTICE '   protected (override/manual) : %', r.protected;
    RAISE NOTICE '   COG would move              : %', r.would_move;
    RAISE NOTICE '   ... by more than 25 pct     : %  <= review these', r.over_25;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   the 10 biggest movers:';
  RAISE NOTICE '   asin         | now    | confirmed | pct    | lots conf/all';
  FOR r IN
    SELECT asin, cog_now, cog_conf, lots_conf, lots_all,
           round(100.0*(cog_conf-cog_now)/NULLIF(cog_now,0),1) AS pct
    FROM chg
    WHERE NOT (has_override OR src='manual') AND cog_now IS NOT NULL AND cog_now > 0
      AND abs(cog_conf - cog_now) > 0.005
    ORDER BY abs(cog_conf - cog_now) DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % | % | % | %/%', rpad(r.asin,12),
      lpad(round(r.cog_now,2)::text,6), lpad(round(r.cog_conf,2)::text,9),
      lpad(COALESCE(r.pct::text,'-'),6), r.lots_conf, r.lots_all;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   2026 COGS movement by month if backfilled:';
  RAISE NOTICE '   month | sales rows | COGS delta';
  FOR r IN
    SELECT EXTRACT(MONTH FROM s.order_date)::int AS m,
           count(*) AS rows,
           round(sum(s.quantity * (ch.cog_conf - COALESCE(s.unit_cost,0)))::numeric,2) AS d
    FROM public.sales_orders s
    JOIN chg ch ON ch.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
      AND NOT (ch.has_override OR ch.src='manual')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %  | % | %', lpad(r.m::text,5), lpad(r.rows::text,10),
      lpad(r.d::text,11);
  END LOOP;
  FOR r IN
    SELECT round(sum(s.quantity * (ch.cog_conf - COALESCE(s.unit_cost,0)))::numeric,2) AS d
    FROM public.sales_orders s
    JOIN chg ch ON ch.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
      AND NOT (ch.has_override OR ch.src='manual')
  LOOP RAISE NOTICE '   2026 TOTAL COGS DELTA (backfill): %', r.d; END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## C. YEAR FIX DRY RUN: best-available rule ########';
  RAISE NOTICE '   rule: confirmed lots where there are 2+, otherwise all lots';
  CREATE TEMP TABLE best AS
  SELECT ev.asin,
         c.unit_cost AS cog_now,
         CASE WHEN ev.lots_conf >= 2 AND ev.units_conf > 0
              THEN round(ev.spent_conf / ev.units_conf, 4)
              ELSE round(ev.spent_all / NULLIF(ev.units_all,0), 4) END AS cog_best,
         CASE WHEN ev.lots_conf >= 2 THEN 'confirmed' ELSE 'all_lots' END AS basis,
         COALESCE(c.source,'(none)') AS src,
         EXISTS (SELECT 1 FROM public.asin_cost_overrides o
                  WHERE o.user_id = v_uid AND o.asin = ev.asin) AS has_override
  FROM ev
  LEFT JOIN public.asin_cog_on_record c ON c.user_id = v_uid AND c.asin = ev.asin;

  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE basis='confirmed') AS by_conf,
           count(*) FILTER (WHERE basis='all_lots') AS by_all,
           count(*) FILTER (WHERE has_override OR src='manual') AS protected,
           count(*) FILTER (WHERE NOT (has_override OR src='manual')
                              AND cog_now IS NOT NULL
                              AND abs(cog_best - cog_now) > 0.005) AS would_move,
           count(*) FILTER (WHERE NOT (has_override OR src='manual')
                              AND cog_now IS NOT NULL AND cog_now > 0
                              AND abs(cog_best - cog_now)/cog_now > 0.25) AS over_25
    FROM best WHERE cog_best IS NOT NULL
  LOOP
    RAISE NOTICE '   ASINs covered               : % (% confirmed basis, % all-lots)',
      r.n, r.by_conf, r.by_all;
    RAISE NOTICE '   protected (override/manual) : %', r.protected;
    RAISE NOTICE '   COG would move              : %', r.would_move;
    RAISE NOTICE '   ... by more than 25 pct     : %', r.over_25;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   2026 COGS movement by month, best-available:';
  RAISE NOTICE '   month | sales rows | COGS delta';
  FOR r IN
    SELECT EXTRACT(MONTH FROM s.order_date)::int AS m, count(*) AS rows,
           round(sum(s.quantity * (b.cog_best - COALESCE(s.unit_cost,0)))::numeric,2) AS d
    FROM public.sales_orders s
    JOIN best b ON b.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
      AND NOT (b.has_override OR b.src='manual') AND b.cog_best IS NOT NULL
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %  | % | %', lpad(r.m::text,5), lpad(r.rows::text,10),
      lpad(r.d::text,11);
  END LOOP;
  FOR r IN
    SELECT round(sum(s.quantity * (b.cog_best - COALESCE(s.unit_cost,0)))::numeric,2) AS d
    FROM public.sales_orders s
    JOIN best b ON b.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
      AND NOT (b.has_override OR b.src='manual') AND b.cog_best IS NOT NULL
  LOOP RAISE NOTICE '   2026 TOTAL COGS DELTA (year fix): %', r.d; END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## CONTROLS ########';
  FOR r IN
    SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) AS claw,
           count(*) AS rows
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP
    RAISE NOTICE '   clawback % | % | fec rows %', r.claw,
      CASE WHEN r.claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END, r.rows;
  END LOOP;
  RAISE NOTICE '   nine-month applied NET -1765.91 (nothing here touches fec)';

  DROP TABLE ev; DROP TABLE chg; DROP TABLE best;
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
