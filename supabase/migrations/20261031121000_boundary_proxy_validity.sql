-- IS THE sales_orders JOIN A VALID PROXY FOR THE POSTING CLOCK? -- READ ONLY.
--
-- 20261031120000 produced month movements in the tens of thousands of dollars
-- (2025-12 +142,976, 2026-01 +114,833). A timezone shift CANNOT do that. Pacific
-- is UTC-8, so re-bucketing by Pacific can only move rows posted in the first
-- eight hours of a UTC day -- at most a third of one day's rows at a month
-- boundary. Six figures means the join is measuring something else: the gap
-- between when a customer BOUGHT and when Amazon POSTED the shipment.
--
-- That is the proxy failing, not the boundary being large. This migration proves
-- which, by printing the lag distribution the previous run's output truncated,
-- and then isolates the only subset where purchase time can stand in for posting
-- time: rows whose event_date equals the purchase UTC date (lag 0). Within that
-- subset, the 00:00-08:00 UTC band is the actual timezone exposure.
DO $p$
DECLARE r record; v_uid uuid; v_in_scope int; v_with_ts int; v_lag01 int;
        v_lag0 int; v_band int; v_cross int; v_net numeric := 0;
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

  CREATE TEMP TABLE ord ON COMMIT DROP AS
  SELECT order_id, min(purchase_timestamp_utc) AS pts
  FROM public.sales_orders WHERE user_id = v_uid GROUP BY order_id;
  CREATE INDEX ON ord (order_id);

  CREATE TEMP TABLE pop ON COMMIT DROP AS
  SELECT f.*, o.pts
  FROM public.financial_events_cache f
  LEFT JOIN ord o ON o.order_id = f.amazon_order_id
  WHERE f.user_id = v_uid
    AND f.event_type IN ('shipment','refund','service_fee','liquidation')
    AND f.event_date >= '2025-01-01' AND f.event_date < '2027-01-01';

  SELECT count(*), count(pts) INTO v_in_scope, v_with_ts FROM pop;

  RAISE NOTICE '== 1. JOIN COVERAGE ==';
  RAISE NOTICE '   FEC rows in scope        : %', v_in_scope;
  RAISE NOTICE '   joined to a purchase ts  : % (% pct)', v_with_ts,
    round(100.0*v_with_ts/greatest(v_in_scope,1),1);
  FOR r IN
    SELECT event_type AS et, count(*) AS n, count(pts) AS with_ts,
           round(100.0*count(pts)/greatest(count(*),1),1) AS pct,
           count(*) FILTER (WHERE COALESCE(amazon_order_id,'') = '') AS no_oid
    FROM pop GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '      % | % rows | % joined | % pct | % with no order id',
         rpad(r.et,12), lpad(r.n::text,7), lpad(r.with_ts::text,7),
         lpad(r.pct::text,5), r.no_oid; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. THE LAG: event_date (posted day) minus purchase UTC day ==';
  RAISE NOTICE '   bucket                             |    rows |   pct';
  FOR r IN
    SELECT CASE WHEN d < -1 THEN 'posted 2+ days BEFORE purchase'
                WHEN d = -1 THEN 'posted 1 day before purchase'
                WHEN d = 0 THEN '0  same UTC day'
                WHEN d = 1 THEN '1  day'
                WHEN d = 2 THEN '2  days'
                WHEN d BETWEEN 3 AND 7 THEN '3-7 days'
                WHEN d BETWEEN 8 AND 30 THEN '8-30 days'
                ELSE 'over 30 days' END AS bucket,
           min(d) AS lo, max(d) AS hi, count(*) AS n
    FROM (SELECT (event_date - (pts AT TIME ZONE 'UTC')::date) AS d
          FROM pop WHERE pts IS NOT NULL) x
    GROUP BY 1 ORDER BY min(d)
  LOOP RAISE NOTICE '   % | % | % | range % .. %', rpad(r.bucket,34),
         lpad(r.n::text,7), lpad(round(100.0*r.n/greatest(v_with_ts,1),1)::text,5),
         r.lo, r.hi; END LOOP;

  SELECT count(*) FILTER (WHERE (event_date - (pts AT TIME ZONE 'UTC')::date) BETWEEN 0 AND 1),
         count(*) FILTER (WHERE (event_date - (pts AT TIME ZONE 'UTC')::date) = 0)
    INTO v_lag01, v_lag0
  FROM pop WHERE pts IS NOT NULL;
  RAISE NOTICE '   lag 0-1 days: % of % (% pct) | lag exactly 0: %',
    v_lag01, v_with_ts, round(100.0*v_lag01/greatest(v_with_ts,1),1), v_lag0;

  IF v_lag01 < v_with_ts * 0.8 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> THE PROXY FAILS. Purchase time does not locate the POSTING day,';
    RAISE NOTICE '   >>> so every month figure in 20261031120000 measures the';
    RAISE NOTICE '   >>> purchase-to-posting LAG, not the timezone. Discard those.';
  ELSE
    RAISE NOTICE '   proxy holds: purchase and posting are the same or adjacent day';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. ISOLATED timezone exposure: lag-0 rows only ==';
  RAISE NOTICE '   Within lag-0 rows, a Pacific re-bucket moves ONLY those purchased';
  RAISE NOTICE '   00:00-07:59 UTC, which is the previous Pacific day.';
  SELECT count(*) INTO v_band FROM pop
   WHERE pts IS NOT NULL
     AND (event_date - (pts AT TIME ZONE 'UTC')::date) = 0
     AND EXTRACT(HOUR FROM (pts AT TIME ZONE 'UTC')) < 8;
  RAISE NOTICE '   lag-0 rows in the 00:00-08:00 UTC band: % of % lag-0 (% pct)',
    v_band, v_lag0, round(100.0*v_band/greatest(v_lag0,1),1);

  SELECT count(*) INTO v_cross FROM pop
   WHERE pts IS NOT NULL
     AND (event_date - (pts AT TIME ZONE 'UTC')::date) = 0
     AND date_trunc('month',(pts AT TIME ZONE 'America/Los_Angeles')::date)
         <> date_trunc('month',event_date);
  RAISE NOTICE '   of those, crossing a MONTH boundary: %', v_cross;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. money on the lag-0 month-crossing rows (the defensible bound) ==';
  FOR r IN
    WITH moving AS (
      SELECT p.*, to_char(p.event_date,'YYYY-MM') AS from_m,
             to_char((p.pts AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM') AS to_m
      FROM pop p
      WHERE p.pts IS NOT NULL
        AND (p.event_date - (p.pts AT TIME ZONE 'UTC')::date) = 0
        AND date_trunc('month',(p.pts AT TIME ZONE 'America/Los_Angeles')::date)
            <> date_trunc('month',p.event_date))
    SELECT m.from_m, m.to_m, e.k AS col, round(sum(e.v::numeric),2) AS amt
    FROM moving m, LATERAL jsonb_each_text(to_jsonb(m)) AS e(k,v)
    WHERE e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND e.k NOT IN ('id','quantity','asin','seller_sku','from_m','to_m')
    GROUP BY 1,2,3 HAVING round(sum(e.v::numeric),2) <> 0
    ORDER BY 1,2,3
  LOOP
    RAISE NOTICE '      % -> % | % | %', r.from_m, r.to_m, rpad(r.col,30),
      lpad(r.amt::text,11);
    IF    r.col = 'compensated_clawback' THEN v_net := v_net + r.amt;
    ELSIF r.col = ANY(v_rincome) THEN v_net := v_net + r.amt;
    ELSIF r.col = ANY(v_rexp)    THEN v_net := v_net - r.amt;
    END IF;
  END LOOP;
  RAISE NOTICE '   net profit effect of all lag-0 month-crossing rows: %', round(v_net,2);
  IF v_cross = 0 THEN
    RAISE NOTICE '   ZERO rows cross a month boundary on the lag-0 subset.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. the YEAR boundary on the lag-0 subset ==';
  SELECT count(*) INTO v_band FROM pop
   WHERE pts IS NOT NULL
     AND (event_date - (pts AT TIME ZONE 'UTC')::date) = 0
     AND EXTRACT(YEAR FROM (pts AT TIME ZONE 'America/Los_Angeles'))
         <> EXTRACT(YEAR FROM event_date);
  RAISE NOTICE '   lag-0 rows whose Pacific year differs from event_date year: %', v_band;
  FOR r IN
    SELECT event_type AS et, to_char(event_date,'YYYY-MM-DD') AS ed,
           to_char(pts,'YYYY-MM-DD HH24:MI') AS utc,
           to_char(pts AT TIME ZONE 'America/Los_Angeles','YYYY-MM-DD HH24:MI') AS pac,
           round(COALESCE(sales,0),2) AS sales
    FROM pop
    WHERE pts IS NOT NULL
      AND (event_date - (pts AT TIME ZONE 'UTC')::date) = 0
      AND EXTRACT(YEAR FROM (pts AT TIME ZONE 'America/Los_Angeles'))
          <> EXTRACT(YEAR FROM event_date)
    ORDER BY pts
  LOOP RAISE NOTICE '      % | event_date % | UTC % | PAC % | sales %',
         rpad(r.et,12), r.ed, r.utc, r.pac, r.sales; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 6. what actually sits at the 2025/2026 boundary, by event_date ==';
  FOR r IN
    SELECT event_type AS et, to_char(event_date,'YYYY-MM-DD') AS ed, count(*) AS n,
           round(sum(COALESCE(sales,0)),2) AS sales,
           count(pts) AS with_ts
    FROM pop
    WHERE event_date BETWEEN '2025-12-30' AND '2026-01-02'
    GROUP BY 1,2 ORDER BY 2,1
  LOOP RAISE NOTICE '      % | % | % rows | sales % | % with purchase ts',
         r.ed, rpad(r.et,12), lpad(r.n::text,5), lpad(r.sales::text,11), r.with_ts; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, nothing fired.';
END
$p$;
