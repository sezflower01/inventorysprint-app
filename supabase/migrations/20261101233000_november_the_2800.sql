-- WHERE DOES ~2,800 COME FROM? READ ONLY.
--
-- My hypothesis was wrong in BOTH directions and is worth stating as such:
-- I predicted the Sales Report would exceed the P&L because of unsettled
-- orders. Measured, the P&L (559.33) EXCEEDS sales_orders qty x sold_price
-- (274.88), and neither is the ~2,800 the seller sees.
--
-- Two things the first query exposed instead:
--
--  1. 148 November order rows exist, but only 16 carry a non-zero sold_price.
--     The other 132 are HIGH_CONFIDENCE_PENDING with sold_price 0 and an
--     ESTIMATED price instead -- so any revenue figure built on sold_price
--     alone misses them, which is why 274.88 is too small.
--
--  2. ZERO November orders have a posted shipment event, yet
--     financial_events_cache holds 559.33 of November shipment sales. Those
--     cannot be the same money. financial_events_cache.event_date is the
--     POSTING date, so the P&L's "November" is October-and-earlier orders that
--     Amazon posted in November. sales_orders.order_date is the ORDER date.
--     The two reports are bucketing the same transactions into DIFFERENT
--     MONTHS, which is structural and permanent, not a sync lag.
--
-- This confirms (1) by computing the estimate-inclusive figure, and sizes (2)
-- by showing which order months November's financial events belong to.
DO $p$
DECLARE r record; v_uid uuid; v_est numeric; v_mixed numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '######## 1. NOVEMBER REVENUE, ESTIMATE-INCLUSIVE ########';
  SELECT round(sum(COALESCE(quantity,0) *
                   COALESCE(NULLIF(sold_price,0),
                            NULLIF(locked_est_price,0),
                            estimated_price, 0))::numeric,2)
    INTO v_mixed
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-11-01' AND order_date < '2026-12-01';
  RAISE NOTICE '   qty x COALESCE(sold_price, locked_est, estimated_price): %',
    COALESCE(v_mixed,0);

  SELECT round(sum(COALESCE(quantity,0) * COALESCE(estimated_price,0))::numeric,2)
    INTO v_est
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    AND order_date >= '2026-11-01' AND order_date < '2026-12-01';
  RAISE NOTICE '   qty x estimated_price alone                           : %',
    COALESCE(v_est,0);
  RAISE NOTICE '   qty x sold_price alone                                : 274.88';
  RAISE NOTICE '   the P&L figure                                        : 559.33';
  RAISE NOTICE '';
  RAISE NOTICE '   whichever of these is ~2,800 is what the Sales Report sums.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. WHOSE ORDERS ARE NOVEMBER''S FINANCIAL EVENTS? ########';
  RAISE NOTICE '   November POSTING events, grouped by the ORDER month they';
  RAISE NOTICE '   belong to. If the P&L''s November is really October''s orders,';
  RAISE NOTICE '   that shows here.';
  RAISE NOTICE '   order month | events |      sales';
  FOR r IN
    SELECT COALESCE(to_char(date_trunc('month', o.order_date),'YYYY-MM'),
                    '(no matching order)') AS mo,
           count(*) AS n,
           round(sum(abs(COALESCE(f.sales,0))),2) AS amt
    FROM public.financial_events_cache f
    LEFT JOIN (SELECT DISTINCT order_id, min(order_date) AS order_date
               FROM public.sales_orders WHERE user_id = v_uid
               GROUP BY order_id) o ON o.order_id = f.amazon_order_id
    WHERE f.user_id = v_uid AND f.event_type = 'shipment'
      AND f.event_date >= '2026-11-01' AND f.event_date < '2026-12-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | %', rpad(r.mo,11), lpad(r.n::text,6),
      lpad(r.amt::text,11);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. HOW BIG IS THIS EFFECT ON A CLOSED MONTH? ########';
  RAISE NOTICE '   September already showed a 4,756.18 gap (7.2 pct) even though';
  RAISE NOTICE '   it is fully settled. Same question for September: are its';
  RAISE NOTICE '   posting events really September orders?';
  FOR r IN
    SELECT COALESCE(to_char(date_trunc('month', o.order_date),'YYYY-MM'),
                    '(no matching order)') AS mo,
           round(sum(abs(COALESCE(f.sales,0))),2) AS amt
    FROM public.financial_events_cache f
    LEFT JOIN (SELECT DISTINCT order_id, min(order_date) AS order_date
               FROM public.sales_orders WHERE user_id = v_uid
               GROUP BY order_id) o ON o.order_id = f.amazon_order_id
    WHERE f.user_id = v_uid AND f.event_type = 'shipment'
      AND f.event_date >= '2026-09-01' AND f.event_date < '2026-10-01'
    GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 6
  LOOP
    RAISE NOTICE '   % | %', rpad(r.mo,11), lpad(r.amt::text,11);
  END LOOP;
  RAISE NOTICE '   If September''s events are mostly September orders, the';
  RAISE NOTICE '   month-boundary spill is small once a month closes, and the';
  RAISE NOTICE '   7.2 pct gap has a different cause -- most likely the non-US';
  RAISE NOTICE '   estimated_price overstatement already on the queue.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
