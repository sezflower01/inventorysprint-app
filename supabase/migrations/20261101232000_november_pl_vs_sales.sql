-- WHY DOES NOVEMBER SHOW 559 IN THE P&L AND ~2,800 IN THE SALES REPORT?
-- READ ONLY.
--
-- The two reports read DIFFERENT TABLES, and for a month two days old that
-- difference is at its largest:
--
--   P&L          -> financial_events_cache. Amazon's Financial Events, which
--                   appear only once Amazon POSTS the transaction. A sale made
--                   today is typically not an event for days.
--   Sales Report -> sales_orders. Written from the Orders API as soon as the
--                   order exists, settled or not, with an ESTIMATED price when
--                   no settled price is known yet.
--
-- So the expected shape is: Sales Report >= P&L for any recent month, with the
-- gap closing as Amazon settles. If that is the whole story the difference will
-- be almost entirely unsettled orders. If it is not, something else is wrong,
-- and this distinguishes the two rather than assuming the benign one.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_fec numeric; v_so numeric; v_settled numeric; v_pending numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. THE TWO SOURCES FOR NOVEMBER ########';
  SELECT round(sum(abs(COALESCE(sales,0))),2) INTO v_fec
  FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_type = 'shipment'
    AND event_date >= '2026-11-01' AND event_date < '2026-12-01';
  RAISE NOTICE '   financial_events_cache (what the P&L reads) : %', COALESCE(v_fec,0);

  SELECT round(sum(COALESCE(quantity,0) * COALESCE(sold_price,0))::numeric,2)
    INTO v_so
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-11-01' AND order_date < '2026-12-01';
  RAISE NOTICE '   sales_orders qty x sold_price              : %', COALESCE(v_so,0);

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. IS THE GAP JUST UNSETTLED ORDERS? ########';
  RAISE NOTICE '   an order is settled here if Amazon has posted a shipment';
  RAISE NOTICE '   event for it -- not by order_status, which is unreliable';
  RAISE NOTICE '   (19,724 orders have been stuck at Pending since 2025-12-28).';
  FOR r IN
    WITH settled AS (
      SELECT DISTINCT amazon_order_id FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type = 'shipment'
        AND amazon_order_id IS NOT NULL
    )
    SELECT
      count(*) AS orders,
      count(*) FILTER (WHERE s.amazon_order_id IS NOT NULL) AS settled_orders,
      count(*) FILTER (WHERE s.amazon_order_id IS NULL) AS unsettled_orders,
      round(sum(COALESCE(o.quantity,0)*COALESCE(o.sold_price,0))
            FILTER (WHERE s.amazon_order_id IS NOT NULL)::numeric,2) AS settled_rev,
      round(sum(COALESCE(o.quantity,0)*COALESCE(o.sold_price,0))
            FILTER (WHERE s.amazon_order_id IS NULL)::numeric,2) AS unsettled_rev
    FROM public.sales_orders o
    LEFT JOIN settled s ON s.amazon_order_id = o.order_id
    WHERE o.user_id = v_uid AND o.order_id NOT LIKE '%-REFUND%'
      AND o.order_date >= '2026-11-01' AND o.order_date < '2026-12-01'
  LOOP
    RAISE NOTICE '   November order rows      : %', r.orders;
    RAISE NOTICE '   settled (event posted)   : % rows | %', r.settled_orders,
      COALESCE(r.settled_rev,0);
    RAISE NOTICE '   NOT yet settled          : % rows | %', r.unsettled_orders,
      COALESCE(r.unsettled_rev,0);
    v_settled := COALESCE(r.settled_rev,0);
    v_pending := COALESCE(r.unsettled_rev,0);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   P&L shows                : %', COALESCE(v_fec,0);
  RAISE NOTICE '   settled per sales_orders : %', COALESCE(v_settled,0);
  RAISE NOTICE '   unexplained residual     : %',
    round(COALESCE(v_settled,0) - COALESCE(v_fec,0),2);
  RAISE NOTICE '';
  RAISE NOTICE '   If the residual is small, the whole difference is timing:';
  RAISE NOTICE '   the Sales Report is counting orders Amazon has not posted';
  RAISE NOTICE '   yet, and the P&L will catch up over the next few days.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. HOW MUCH OF NOVEMBER IS ESTIMATED, NOT REAL? ########';
  RAISE NOTICE '   an unsettled order carries an ESTIMATE, and the estimator is';
  RAISE NOTICE '   known to overstate by ~27 pct (it reads submitted prices, not';
  RAISE NOTICE '   the observed Buy Box). So the Sales Report figure for a fresh';
  RAISE NOTICE '   month is soft in a known direction.';
  FOR r IN
    SELECT COALESCE(price_source,'(null)') AS src,
           COALESCE(price_confidence,'-') AS conf,
           count(*) AS n,
           round(sum(COALESCE(quantity,0)*COALESCE(sold_price,0))::numeric,2) AS rev
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= '2026-11-01' AND order_date < '2026-12-01'
    GROUP BY 1,2 ORDER BY 4 DESC NULLS LAST
  LOOP
    RAISE NOTICE '   % | % | % rows | %', rpad(r.src,24), rpad(r.conf,22),
      lpad(r.n::text,4), lpad(r.rev::text,10);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. THE SAME TEST ON A CLOSED MONTH ########';
  RAISE NOTICE '   if the explanation is timing, a settled month should agree';
  RAISE NOTICE '   closely. September, fully settled:';
  FOR r IN
    SELECT
      round((SELECT sum(abs(COALESCE(sales,0))) FROM public.financial_events_cache
             WHERE user_id = v_uid AND event_type='shipment'
               AND event_date >= '2026-09-01' AND event_date < '2026-10-01'),2) AS fec,
      round((SELECT sum(COALESCE(quantity,0)*COALESCE(sold_price,0))
             FROM public.sales_orders
             WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
               AND order_date >= '2026-09-01' AND order_date < '2026-10-01')::numeric,2) AS so
  LOOP
    RAISE NOTICE '   September: financial events % | sales_orders % | diff %',
      r.fec, r.so, round(COALESCE(r.so,0) - COALESCE(r.fec,0),2);
    IF r.fec > 0 THEN
      RAISE NOTICE '   September gap as pct of P&L: % pct',
        round(100.0*(COALESCE(r.so,0)-r.fec)/r.fec,1);
    END IF;
  END LOOP;
  RAISE NOTICE '   A small September gap plus a large November one is timing.';
  RAISE NOTICE '   A large gap in BOTH would mean the two reports disagree';
  RAISE NOTICE '   structurally, which would be a real defect.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
