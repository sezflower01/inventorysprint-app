-- The year-fix total and controls, which scrolled off the previous run.
-- READ ONLY.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  CREATE TEMP TABLE ev2 AS
  SELECT cl.asin, count(*) AS lots_all, sum(cl.cost) AS spent_all,
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
           ORDER BY GREATEST(a.units_shipped, a.units_allocated) DESC LIMIT 1),0)) AS units_conf
  FROM public.created_listings cl
  WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
    AND cl.created_at >= date_trunc('year', now())
  GROUP BY cl.asin;

  CREATE TEMP TABLE best2 AS
  SELECT ev2.asin, c.unit_cost AS cog_now,
         CASE WHEN ev2.lots_conf >= 2 AND ev2.units_conf > 0
              THEN round(ev2.spent_conf / ev2.units_conf, 4)
              ELSE round(ev2.spent_all / NULLIF(ev2.units_all,0), 4) END AS cog_best,
         COALESCE(c.source,'(none)') AS src,
         EXISTS (SELECT 1 FROM public.asin_cost_overrides o
                  WHERE o.user_id = v_uid AND o.asin = ev2.asin) AS has_override
  FROM ev2 LEFT JOIN public.asin_cog_on_record c
    ON c.user_id = v_uid AND c.asin = ev2.asin;

  FOR r IN
    SELECT EXTRACT(MONTH FROM s.order_date)::int AS m,
           round(sum(s.quantity * (b.cog_best - COALESCE(s.unit_cost,0)))::numeric,2) AS d
    FROM public.sales_orders s JOIN best2 b ON b.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-07-01'
      AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
      AND NOT (b.has_override OR b.src='manual') AND b.cog_best IS NOT NULL
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE 'month % | COGS delta %', lpad(r.m::text,2), lpad(r.d::text,10); END LOOP;

  FOR r IN
    SELECT round(sum(s.quantity * (b.cog_best - COALESCE(s.unit_cost,0)))::numeric,2) AS d,
           count(*) AS rows
    FROM public.sales_orders s JOIN best2 b ON b.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%'
      AND NOT (b.has_override OR b.src='manual') AND b.cog_best IS NOT NULL
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '2026 TOTAL COGS DELTA (year fix, best-available): % over % rows',
      r.d, r.rows;
  END LOOP;

  FOR r IN
    SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) AS claw, count(*) AS n
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP
    RAISE NOTICE 'clawback % | % | fec rows %', r.claw,
      CASE WHEN r.claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END, r.n;
  END LOOP;
  RAISE NOTICE 'nine-month applied NET -1765.91 -- nothing here touches fec';
  DROP TABLE ev2; DROP TABLE best2;
  RAISE NOTICE 'READ ONLY -- nothing written.';
END
$p$;
