-- WHICH "THIS PURCHASE IS REAL" SIGNAL CAN ACTUALLY CARRY THE GATE?
-- READ ONLY.
--
-- The shipment gate as specified cannot work yet: shipment_id is NULL on all
-- 628 allocation rows, units_shipped > 0 reaches only 190 of 1,536 lots (12.4
-- pct of lots, 13.0 pct of spend), and 143 of 227 products would lose their
-- average outright. The idea is right; the builder is not recording enough to
-- support it.
--
-- So the question becomes: what OTHER evidence of a real purchase already
-- exists, and does any of it have the coverage the gate needs? Four candidates,
-- measured side by side on the same 1,536 lots. The winner needs high coverage
-- AND to be hard to set by accident -- a signal the seller fills in by hand is
-- no better than the manual button they already have.
DO $p$
DECLARE r record; v_uid uuid; v_lots int; v_spend numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*), round(sum(cost),2) INTO v_lots, v_spend
  FROM public.created_listings
  WHERE user_id = v_uid AND cost > 0 AND units > 0
    AND created_at >= date_trunc('year', now());
  RAISE NOTICE 'baseline: % lots, % spend', v_lots, v_spend;

  RAISE NOTICE '';
  RAISE NOTICE 'signal                        | lots | pct  |      spend | pct';
  FOR r IN
    WITH base AS (
      SELECT cl.id, cl.cost, cl.units, cl.asin,
             COALESCE(cl.received_quantity,0) AS recvd,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      WHERE a.created_listing_id = cl.id) AS allocated,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      WHERE a.created_listing_id = cl.id AND a.units_shipped > 0) AS shipped,
             EXISTS (SELECT 1 FROM public.sales_orders s
                      WHERE s.user_id = v_uid AND s.asin = cl.asin
                        AND s.order_date >= cl.created_at::date) AS sold_after
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now()))
    SELECT 'received_quantity > 0' AS sig,
           count(*) FILTER (WHERE recvd > 0) AS lots,
           round(sum(cost) FILTER (WHERE recvd > 0),2) AS spend FROM base
    UNION ALL SELECT 'allocated to a draft',
           count(*) FILTER (WHERE allocated), round(sum(cost) FILTER (WHERE allocated),2) FROM base
    UNION ALL SELECT 'units_shipped > 0',
           count(*) FILTER (WHERE shipped), round(sum(cost) FILTER (WHERE shipped),2) FROM base
    UNION ALL SELECT 'ASIN sold after purchase',
           count(*) FILTER (WHERE sold_after), round(sum(cost) FILTER (WHERE sold_after),2) FROM base
    UNION ALL SELECT 'allocated OR received',
           count(*) FILTER (WHERE allocated OR recvd > 0),
           round(sum(cost) FILTER (WHERE allocated OR recvd > 0),2) FROM base
  LOOP
    RAISE NOTICE '   % | % | % | % | %', rpad(r.sig,28), lpad(r.lots::text,4),
      lpad(round(100.0*r.lots/NULLIF(v_lots,0),1)::text,4),
      lpad(COALESCE(r.spend,0)::text,10),
      lpad(round(100.0*COALESCE(r.spend,0)/NULLIF(v_spend,0),1)::text,4);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'how many products keep an average under each gate?';
  RAISE NOTICE '(needs 2+ qualifying lots, same rule the page uses today)';
  FOR r IN
    WITH base AS (
      SELECT cl.asin,
             COALESCE(cl.received_quantity,0) > 0 AS recvd,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      WHERE a.created_listing_id = cl.id) AS allocated,
             EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                      WHERE a.created_listing_id = cl.id AND a.units_shipped > 0) AS shipped
      FROM public.created_listings cl
      WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
        AND cl.created_at >= date_trunc('year', now()))
    SELECT count(*) FILTER (WHERE n >= 2) AS now_,
           count(*) FILTER (WHERE n_recvd >= 2) AS by_recvd,
           count(*) FILTER (WHERE n_alloc >= 2) AS by_alloc,
           count(*) FILTER (WHERE n_ship >= 2) AS by_ship,
           count(*) FILTER (WHERE n_either >= 2) AS by_either
    FROM (SELECT asin, count(*) AS n,
                 count(*) FILTER (WHERE recvd) AS n_recvd,
                 count(*) FILTER (WHERE allocated) AS n_alloc,
                 count(*) FILTER (WHERE shipped) AS n_ship,
                 count(*) FILTER (WHERE allocated OR recvd) AS n_either
          FROM base GROUP BY asin) x
  LOOP
    RAISE NOTICE '   today (any purchase)      : % products', r.now_;
    RAISE NOTICE '   received_quantity > 0     : %', r.by_recvd;
    RAISE NOTICE '   allocated to a draft      : %', r.by_alloc;
    RAISE NOTICE '   units_shipped > 0         : %', r.by_ship;
    RAISE NOTICE '   allocated OR received     : %', r.by_either;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
