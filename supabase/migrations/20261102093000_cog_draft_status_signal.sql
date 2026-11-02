-- THE SIGNAL WAS THERE ALL ALONG: draft STATUS. READ ONLY.
--
-- shipment_purchase_allocations.shipment_id is NULL on every row, which is what
-- made the shipment gate look unusable. But shipment_builder_drafts already
-- carries the whole lifecycle per draft:
--
--   status              draft | continued | synced | completed | archived
--   inbound_plan_id     Amazon's plan id
--   amazon_shipment_id  Amazon's shipment id
--   continued_to_amazon_at  when it left for Amazon
--
-- An allocation knows its draft_id. So "this purchase went to Amazon" is a join
-- away and needs no new plumbing at all. That is a far better gate than
-- units_shipped, and it is exactly the seller's own definition: the shipment is
-- the trusted document.
--
-- This measures coverage by draft status before anything is proposed.
DO $p$
DECLARE r record; v_uid uuid; v_lots int; v_spend numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '######## 1. DRAFTS BY STATUS ########';
  FOR r IN
    SELECT COALESCE(status,'(null)') AS st, count(*) AS n,
           count(*) FILTER (WHERE inbound_plan_id IS NOT NULL) AS with_plan,
           count(*) FILTER (WHERE amazon_shipment_id IS NOT NULL) AS with_ship,
           count(*) FILTER (WHERE continued_to_amazon_at IS NOT NULL) AS continued
    FROM public.shipment_builder_drafts WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % drafts | % plan_id | % shipment_id | % continued',
      rpad(r.st,12), lpad(r.n::text,4), lpad(r.with_plan::text,4),
      lpad(r.with_ship::text,4), lpad(r.continued::text,4);
  END LOOP;

  ------------------------------------------------------------------
  SELECT count(*), round(sum(cost),2) INTO v_lots, v_spend
  FROM public.created_listings
  WHERE user_id = v_uid AND cost > 0 AND units > 0
    AND created_at >= date_trunc('year', now());

  RAISE NOTICE '';
  RAISE NOTICE '######## 2. COVERAGE BY DRAFT-STATUS GATE ########';
  RAISE NOTICE '   baseline: % lots, % spend', v_lots, v_spend;
  RAISE NOTICE '   gate                              | lots | pct  |      spend | pct';
  FOR r IN
    WITH base AS (
      SELECT cl.id, cl.cost, cl.units, cl.asin,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      JOIN public.shipment_builder_drafts d
                        ON d.user_id = a.user_id AND d.draft_id = a.draft_id
                     WHERE a.created_listing_id = cl.id
                       AND d.status IN ('continued','synced','completed')) AS went,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      JOIN public.shipment_builder_drafts d
                        ON d.user_id = a.user_id AND d.draft_id = a.draft_id
                     WHERE a.created_listing_id = cl.id
                       AND d.continued_to_amazon_at IS NOT NULL) AS continued,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      JOIN public.shipment_builder_drafts d
                        ON d.user_id = a.user_id AND d.draft_id = a.draft_id
                     WHERE a.created_listing_id = cl.id
                       AND d.inbound_plan_id IS NOT NULL) AS has_plan,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      JOIN public.shipment_builder_drafts d
                        ON d.user_id = a.user_id AND d.draft_id = a.draft_id
                     WHERE a.created_listing_id = cl.id
                       AND d.status = 'completed') AS completed
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now()))
    SELECT 'draft continued/synced/completed' AS g,
           count(*) FILTER (WHERE went) AS lots,
           round(sum(cost) FILTER (WHERE went),2) AS spend FROM base
    UNION ALL SELECT 'continued_to_amazon_at set',
           count(*) FILTER (WHERE continued), round(sum(cost) FILTER (WHERE continued),2) FROM base
    UNION ALL SELECT 'has inbound_plan_id',
           count(*) FILTER (WHERE has_plan), round(sum(cost) FILTER (WHERE has_plan),2) FROM base
    UNION ALL SELECT 'status = completed only',
           count(*) FILTER (WHERE completed), round(sum(cost) FILTER (WHERE completed),2) FROM base
  LOOP
    RAISE NOTICE '   % | % | % | % | %', rpad(r.g,33), lpad(r.lots::text,4),
      lpad(round(100.0*r.lots/NULLIF(v_lots,0),1)::text,4),
      lpad(COALESCE(r.spend,0)::text,10),
      lpad(round(100.0*COALESCE(r.spend,0)/NULLIF(v_spend,0),1)::text,4);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. PRODUCTS KEEPING AN AVERAGE (2+ qualifying lots) ########';
  FOR r IN
    WITH base AS (
      SELECT cl.asin,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      JOIN public.shipment_builder_drafts d
                        ON d.user_id = a.user_id AND d.draft_id = a.draft_id
                     WHERE a.created_listing_id = cl.id
                       AND d.status IN ('continued','synced','completed')) AS went
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now()))
    SELECT count(*) FILTER (WHERE n >= 2) AS today,
           count(*) FILTER (WHERE n_went >= 2) AS gated,
           count(*) FILTER (WHERE n_went = 1) AS one_only,
           count(*) FILTER (WHERE n_went = 0) AS none_
    FROM (SELECT asin, count(*) AS n, count(*) FILTER (WHERE went) AS n_went
          FROM base GROUP BY asin) x
  LOOP
    RAISE NOTICE '   products with 2+ purchases today      : %', r.today;
    RAISE NOTICE '   ... with 2+ that WENT to Amazon       : %', r.gated;
    RAISE NOTICE '   ... with exactly 1 that went          : %', r.one_only;
    RAISE NOTICE '   ... with none that went               : %', r.none_;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
