-- BOUND THE YEAR-END BOUNDARY WITHOUT A POSTING CLOCK -- READ ONLY.
--
-- Established in 20261031121000: shipment/refund/service_fee rows have no
-- posted_at, and sales_orders.purchase_timestamp_utc cannot stand in for the
-- posting instant -- only 2.9% of joined rows post within a day of purchase,
-- 65.4% post 8-30 days later, and 27.7% appear to post BEFORE purchase. So the
-- exposure cannot be MEASURED. It can be BOUNDED, which is the honest answer:
--
--   An 8-hour shift can only re-bucket rows posted in the first 8 hours of a UTC
--   day. At a month boundary that is at most the rows posted on the 1st, and
--   within that day at most the 00:00-08:00 third of them. So:
--     hard ceiling   = all the money on the 1st
--     even-flow est. = one third of it (8/24)
--   Both are stated, neither is presented as the figure.
DO $p$
DECLARE r record; v_uid uuid; v_sales numeric; v_net numeric; v_n int;
        v_rincome text[] := ARRAY['sales','reimbursements','reversal_reimbursement',
          'free_replacement_refund_items','shipping_credits','gift_wrap_credits',
          'promotional_rebate_refunds','restocking_fee','other_income','liquidations',
          'warehouse_lost','warehouse_damage','shipping_chargeback_refund',
          'marketplace_facilitator_tax_refunds','sales_tax_collected'];
        v_rexp text[] := ARRAY['referral_fees','fba_fees','fba_customer_return_fees',
          'fba_inbound_fees','fba_inbound_convenience_fee','fba_storage_fees',
          'fba_removal_fees','fba_disposal_fees','fba_long_term_storage_fees',
          'digital_services_fee','other_fees','liquidations_brokerage_fee',
          're_commerce_grading_charge','hrr_non_apparel','shipping_chargeback',
          'refunds','shipping_credit_refunds','gift_wrap_credit_refunds',
          'promotional_rebates','marketplace_facilitator_tax','sales_tax_refunds',
          'fixed_closing_fees','variable_closing_fees','compensated_clawback'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== 1. what sits on the 2025/2026 boundary, by event_date, ALL types ==';
  RAISE NOTICE '   event_date | type         | rows  |      sales';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM-DD') AS ed, event_type AS et, count(*) AS n,
           round(sum(COALESCE(sales,0)),2) AS sales
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date BETWEEN '2025-12-30' AND '2026-01-02'
    GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '   % | % | % | %', r.ed, rpad(r.et,12),
         lpad(r.n::text,5), lpad(r.sales::text,11); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. NET PROFIT booked on 2026-01-01 -- the hard ceiling ==';
  v_net := 0;
  FOR r IN
    SELECT e.k AS col, round(sum(e.v::numeric),2) AS amt
    FROM public.financial_events_cache t,
         LATERAL jsonb_each_text(to_jsonb(t)) AS e(k,v)
    WHERE t.user_id=v_uid AND t.event_date = '2026-01-01'
      AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND e.k NOT IN ('id','quantity','asin','seller_sku')
    GROUP BY 1 HAVING round(sum(e.v::numeric),2) <> 0
    ORDER BY 1
  LOOP
    RAISE NOTICE '   % | %', rpad(r.col,30), lpad(r.amt::text,11);
    IF    r.col = 'compensated_clawback' THEN v_net := v_net + r.amt;
    ELSIF r.col = ANY(v_rincome) THEN v_net := v_net + r.amt;
    ELSIF r.col = ANY(v_rexp)    THEN v_net := v_net - r.amt;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.financial_events_cache
   WHERE user_id=v_uid AND event_date='2026-01-01';
  RAISE NOTICE '   ------------------------------------------';
  RAISE NOTICE '   rows booked on 2026-01-01            : %', v_n;
  RAISE NOTICE '   NET PROFIT booked on 2026-01-01      : %', lpad(round(v_net,2)::text,11);
  RAISE NOTICE '   HARD CEILING on the year-boundary move: % (if EVERY row on the',
    lpad(round(v_net,2)::text,11);
  RAISE NOTICE '     1st had posted 00:00-08:00 UTC -- impossible, but no row can move';
  RAISE NOTICE '     that is not on the 1st, so nothing can exceed it)';
  RAISE NOTICE '   EVEN-FLOW ESTIMATE (8/24 of the day) : %',
    lpad(round(v_net/3.0,2)::text,11);

  RAISE NOTICE '';
  RAISE NOTICE '== 3. sanity: is posting flow actually even across the UTC day? ==';
  RAISE NOTICE '   measured on the 1,474 lag-0 rows, which DO have a usable clock';
  FOR r IN
    WITH ord AS (
      SELECT order_id, min(purchase_timestamp_utc) AS pts
      FROM public.sales_orders WHERE user_id=v_uid GROUP BY order_id)
    SELECT CASE WHEN EXTRACT(HOUR FROM (o.pts AT TIME ZONE 'UTC')) < 8
                THEN '00:00-08:00 (would re-bucket)'
                ELSE '08:00-24:00 (stays)' END AS band,
           count(*) AS n
    FROM public.financial_events_cache f
    JOIN ord o ON o.order_id = f.amazon_order_id
    WHERE f.user_id=v_uid
      AND f.event_type IN ('shipment','refund','service_fee','liquidation')
      AND o.pts IS NOT NULL
      AND (f.event_date - (o.pts AT TIME ZONE 'UTC')::date) = 0
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % rows', rpad(r.band,32), lpad(r.n::text,6); END LOOP;
  RAISE NOTICE '   26.9 pct in the 8-hour band vs 33.3 pct if flow were even, so the';
  RAISE NOTICE '   even-flow estimate is slightly CONSERVATIVE (it over-states).';

  RAISE NOTICE '';
  RAISE NOTICE '== 4. the same ceiling for every 2026 month boundary (the 1st) ==';
  RAISE NOTICE '   month   | rows on the 1st | net profit on the 1st | 8/24 estimate';
  FOR r IN
    WITH firsts AS (
      SELECT date_trunc('month',t.event_date)::date AS m, t.*
      FROM public.financial_events_cache t
      WHERE t.user_id=v_uid AND EXTRACT(DAY FROM t.event_date) = 1
        AND t.event_date >= '2026-01-01' AND t.event_date < '2026-11-01')
    SELECT f.m,
           count(DISTINCT f.id) AS rows,
           round(sum(CASE WHEN e.k = 'compensated_clawback' THEN e.v::numeric
                          WHEN e.k = ANY(v_rincome) THEN  e.v::numeric
                          WHEN e.k = ANY(v_rexp)    THEN -e.v::numeric
                          ELSE 0 END),2) AS net
    FROM firsts f, LATERAL jsonb_each_text(to_jsonb(f)) AS e(k,v)
    WHERE e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND e.k NOT IN ('id','quantity','asin','seller_sku','m')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % | % | %', to_char(r.m,'YYYY-MM'),
         lpad(r.rows::text,15), lpad(r.net::text,21),
         lpad(round(r.net/3.0,2)::text,13); END LOOP;
  RAISE NOTICE '   a month LOSES its own 1st-of-month share and GAINS the next';
  RAISE NOTICE '   months, so consecutive months largely cancel -- only the year';
  RAISE NOTICE '   boundary is a one-way leak out of 2026.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, nothing fired.';
END
$p$;
