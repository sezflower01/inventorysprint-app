-- SIZE THE BOUNDARY FOR SHIPMENTS, REFUNDS AND SERVICE FEES -- READ ONLY.
--
-- These rows have no posted_at (0.0% coverage, measured in 20261031110000), so
-- the only available clock is sales_orders.purchase_timestamp_utc, joined by
-- order id. Two things must be established BEFORE any money figure is quoted,
-- or the number will be confidently wrong:
--
--   1. JOIN COVERAGE. financial_events_cache.amazon_order_id vs
--      sales_orders.order_id (different column names, same identifier).
--      purchase_timestamp_utc is NULL on roughly 10% of sales_orders rows.
--
--   2. WHETHER PURCHASE TIME CAN PROXY POSTING TIME AT ALL. event_date is the
--      POSTED day; purchase_timestamp_utc is when the customer bought. Those are
--      different instants, and Amazon posts a shipment some time after purchase.
--      If the lag is mostly 0-1 days the proxy is defensible for a boundary
--      question; if it is spread over a week, then a row near midnight on
--      Dec 31 by purchase time says nothing about which day it POSTED, and the
--      honest answer is that this join cannot size the boundary. Step 2 measures
--      the lag distribution and the later steps are read in that light.
--
-- sales_orders is one row per order ITEM (unique on user_id, order_id, asin), so
-- the timestamp is collapsed to one row per order_id first. Joining the raw table
-- would fan every shipment row out across the order's items and multiply the
-- money by the item count.
DO $p$
DECLARE r record; v_uid uuid; v_fec int; v_with_oid int; v_matched int;
        v_with_ts int; v_lag0 int; v_lagn int; v_net numeric := 0;
        v_cross int; v_yr int;
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
        v_m date; v_months date[]; v_mnet numeric; v_mclaw numeric;
        v_unknown int; v_total numeric := 0; v_febsep numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  -- One timestamp per order, not per order item.
  CREATE TEMP TABLE ord ON COMMIT DROP AS
  SELECT order_id,
         min(purchase_timestamp_utc) AS pts,
         min(order_date)             AS odate
  FROM public.sales_orders
  WHERE user_id = v_uid
  GROUP BY order_id;
  CREATE INDEX ON ord (order_id);

  SELECT count(*) INTO v_fec FROM public.sales_orders WHERE user_id=v_uid;
  SELECT count(*) INTO v_matched FROM ord;
  RAISE NOTICE '== 0. sales_orders: % item rows collapsed to % orders ==', v_fec, v_matched;

  -- The population: the three types with no posted_at, plus liquidation.
  CREATE TEMP TABLE pop ON COMMIT DROP AS
  SELECT f.*, o.pts, o.odate
  FROM public.financial_events_cache f
  LEFT JOIN ord o ON o.order_id = f.amazon_order_id
  WHERE f.user_id = v_uid
    AND f.event_type IN ('shipment','refund','service_fee','liquidation')
    AND f.event_date >= '2025-01-01' AND f.event_date < '2027-01-01';

  SELECT count(*) INTO v_fec FROM pop;
  SELECT count(*) INTO v_with_oid FROM pop WHERE COALESCE(amazon_order_id,'') <> '';
  SELECT count(*) INTO v_matched FROM pop WHERE pts IS NOT NULL OR odate IS NOT NULL;
  SELECT count(*) INTO v_with_ts FROM pop WHERE pts IS NOT NULL;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. JOIN COVERAGE ==';
  RAISE NOTICE '   FEC rows in scope (shipment/refund/service_fee/liquidation): %', v_fec;
  RAISE NOTICE '   with an amazon_order_id            : % (% pct)', v_with_oid,
    round(100.0*v_with_oid/greatest(v_fec,1),1);
  RAISE NOTICE '   matched to a sales_orders order    : % (% pct)', v_matched,
    round(100.0*v_matched/greatest(v_fec,1),1);
  RAISE NOTICE '   of those, with purchase_timestamp  : % (% pct of all)', v_with_ts,
    round(100.0*v_with_ts/greatest(v_fec,1),1);
  RAISE NOTICE '   coverage by type:';
  FOR r IN
    SELECT event_type AS et, count(*) AS n,
           count(*) FILTER (WHERE pts IS NOT NULL) AS with_ts,
           round(100.0*count(*) FILTER (WHERE pts IS NOT NULL)/greatest(count(*),1),1) AS pct
    FROM pop GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '      % | % rows | % with purchase ts | % pct',
         rpad(r.et,12), lpad(r.n::text,7), lpad(r.with_ts::text,7), lpad(r.pct::text,5); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. CAN PURCHASE TIME PROXY POSTING TIME? lag = event_date - purchase day ==';
  FOR r IN
    SELECT CASE WHEN d < 0 THEN 'negative (posted BEFORE purchase?)'
                WHEN d = 0 THEN '0 days (same UTC day)'
                WHEN d = 1 THEN '1 day'
                WHEN d = 2 THEN '2 days'
                WHEN d BETWEEN 3 AND 7 THEN '3-7 days'
                WHEN d BETWEEN 8 AND 30 THEN '8-30 days'
                ELSE 'over 30 days' END AS bucket,
           min(d) AS lo, max(d) AS hi, count(*) AS n,
           round(100.0*count(*)/greatest(sum(count(*)) OVER (),1),1) AS pct
    FROM (SELECT (event_date - (pts AT TIME ZONE 'UTC')::date) AS d
          FROM pop WHERE pts IS NOT NULL) x
    GROUP BY 1 ORDER BY min(d)
  LOOP RAISE NOTICE '   % | % rows | % pct | range % .. %',
         rpad(r.bucket,34), lpad(r.n::text,7), lpad(r.pct::text,5), r.lo, r.hi; END LOOP;

  SELECT count(*) FILTER (WHERE (event_date - (pts AT TIME ZONE 'UTC')::date) BETWEEN 0 AND 1),
         count(*)
    INTO v_lag0, v_lagn
  FROM pop WHERE pts IS NOT NULL;
  RAISE NOTICE '   within 0-1 days: % of % (% pct)', v_lag0, v_lagn,
    round(100.0*v_lag0/greatest(v_lagn,1),1);
  IF v_lag0 < v_lagn * 0.8 THEN
    RAISE NOTICE '   >>> THE PROXY IS WEAK. Purchase time does not locate the POSTING';
    RAISE NOTICE '   >>> day closely enough to decide which month a row posted in, so the';
    RAISE NOTICE '   >>> figures below BOUND the exposure, they do not measure it.';
  ELSE
    RAISE NOTICE '   proxy acceptable: purchase and posting land on the same day or next';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. THE YEAR WINDOW: purchased 2025-12-31 or 2026-01-01 UTC ==';
  SELECT count(*) INTO v_yr FROM pop
   WHERE pts >= '2025-12-31 00:00:00+00' AND pts < '2026-01-02 00:00:00+00';
  RAISE NOTICE '   FEC rows in that 48h purchase window: %', v_yr;
  FOR r IN
    SELECT event_type AS et,
           to_char(event_date,'YYYY-MM-DD') AS ed,
           to_char(pts,'YYYY-MM-DD HH24:MI') AS utc,
           to_char(pts AT TIME ZONE 'America/Los_Angeles','YYYY-MM-DD HH24:MI') AS pac,
           count(*) AS n,
           round(sum(COALESCE(sales,0)),2) AS sales
    FROM pop
    WHERE pts >= '2025-12-31 00:00:00+00' AND pts < '2026-01-02 00:00:00+00'
    GROUP BY 1,2,3,4 ORDER BY 3
  LOOP RAISE NOTICE '   % | event_date % | UTC % | PAC % | % rows | sales %',
         rpad(r.et,12), r.ed, r.utc, r.pac, r.n, r.sales; END LOOP;
  RAISE NOTICE '   rows whose event_date YEAR differs from their Pacific purchase year:';
  SELECT count(*) INTO v_yr FROM pop
   WHERE pts IS NOT NULL
     AND EXTRACT(YEAR FROM (pts AT TIME ZONE 'America/Los_Angeles')) <> EXTRACT(YEAR FROM event_date);
  RAISE NOTICE '      % rows', v_yr;
  FOR r IN
    SELECT EXTRACT(YEAR FROM event_date)::int AS ed_yr,
           EXTRACT(YEAR FROM (pts AT TIME ZONE 'America/Los_Angeles'))::int AS pac_yr,
           event_type AS et, count(*) AS n, round(sum(COALESCE(sales,0)),2) AS sales
    FROM pop
    WHERE pts IS NOT NULL
      AND EXTRACT(YEAR FROM (pts AT TIME ZONE 'America/Los_Angeles')) <> EXTRACT(YEAR FROM event_date)
    GROUP BY 1,2,3 ORDER BY 1,2,3
  LOOP RAISE NOTICE '      event_date % -> Pacific purchase % | % | % rows | sales %',
         r.ed_yr, r.pac_yr, rpad(r.et,12), r.n, r.sales; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. MONTH CROSSING by Pacific purchase day vs event_date ==';
  SELECT count(*) INTO v_cross FROM pop
   WHERE pts IS NOT NULL
     AND date_trunc('month',(pts AT TIME ZONE 'America/Los_Angeles')::date)
         <> date_trunc('month',event_date);
  RAISE NOTICE '   rows crossing a month boundary: % of % with a timestamp (% pct)',
    v_cross, v_with_ts, round(100.0*v_cross/greatest(v_with_ts,1),1);
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS from_m,
           to_char((pts AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM') AS to_m,
           count(*) AS n, round(sum(COALESCE(sales,0)),2) AS sales
    FROM pop
    WHERE pts IS NOT NULL
      AND date_trunc('month',(pts AT TIME ZONE 'America/Los_Angeles')::date)
          <> date_trunc('month',event_date)
      AND event_date >= '2025-12-01'
    GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '      % -> % | % rows | sales %', r.from_m, r.to_m,
         lpad(r.n::text,6), lpad(r.sales::text,11); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. NET PROFIT that would move, month-crossing rows, 2026 months ==';
  FOR r IN
    WITH moving AS (
      SELECT p.*, to_char(p.event_date,'YYYY-MM') AS from_m,
             to_char((p.pts AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM') AS to_m
      FROM pop p
      WHERE p.pts IS NOT NULL
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
  RAISE NOTICE '   sum of the profit effect of every month-crossing row: %', round(v_net,2);
  RAISE NOTICE '   (direction is one-way -- Pacific is behind UTC, so a row only ever';
  RAISE NOTICE '    moves to an EARLIER month: the from_m loses it, the to_m gains it)';

  RAISE NOTICE '';
  RAISE NOTICE '== 6. per-month profit impact, 2026, from the month-crossing rows ==';
  RAISE NOTICE '   month   | leaves      | arrives     | net change';
  FOR r IN
    WITH moving AS (
      SELECT p.*, to_char(p.event_date,'YYYY-MM') AS from_m,
             to_char((p.pts AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM') AS to_m
      FROM pop p
      WHERE p.pts IS NOT NULL
        AND date_trunc('month',(p.pts AT TIME ZONE 'America/Los_Angeles')::date)
            <> date_trunc('month',p.event_date)),
    eff AS (
      SELECT m.from_m, m.to_m,
             sum(CASE WHEN e.k = 'compensated_clawback' THEN e.v::numeric
                      WHEN e.k = ANY(v_rincome) THEN  e.v::numeric
                      WHEN e.k = ANY(v_rexp)    THEN -e.v::numeric
                      ELSE 0 END) AS eff
      FROM moving m, LATERAL jsonb_each_text(to_jsonb(m)) AS e(k,v)
      WHERE e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        AND e.k NOT IN ('id','quantity','asin','seller_sku','from_m','to_m')
      GROUP BY 1,2),
    agg AS (
      SELECT from_m AS m, -sum(eff) AS delta FROM eff GROUP BY 1
      UNION ALL
      SELECT to_m   AS m,  sum(eff) AS delta FROM eff GROUP BY 1)
    SELECT m, round(sum(delta),2) AS net,
           round(sum(CASE WHEN delta < 0 THEN delta ELSE 0 END),2) AS leaves,
           round(sum(CASE WHEN delta > 0 THEN delta ELSE 0 END),2) AS arrives
    FROM agg GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % | % | %', r.m, lpad(r.leaves::text,11),
         lpad(r.arrives::text,11), lpad(r.net::text,11); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 7. THE NINE-MONTH NET TABLE, each month from its own backup ==';
  RAISE NOTICE '   month   | clawback   | other moved | NET PROFIT | unknown cols';
  v_months := ARRAY['2026-01-01','2026-02-01','2026-03-01','2026-04-01','2026-05-01',
                    '2026-06-01','2026-07-01','2026-08-01','2026-09-01']::date[];
  FOREACH v_m IN ARRAY v_months LOOP
    v_mnet := 0; v_mclaw := 0; v_unknown := 0;
    FOR r IN
      WITH b AS (
        SELECT e.k, sum(e.v::numeric) AS tot
        FROM public.fec_repull_backup t,
             LATERAL jsonb_each_text(to_jsonb(t) - 'backup_month' - 'backed_up_at') AS e(k,v)
        WHERE t.backup_month = v_m AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        GROUP BY 1),
      l AS (
        SELECT e.k, sum(e.v::numeric) AS tot
        FROM public.financial_events_cache t,
             LATERAL jsonb_each_text(to_jsonb(t)) AS e(k,v)
        WHERE t.user_id = v_uid AND t.event_date >= v_m
          AND t.event_date < (v_m + interval '1 month')
          AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        GROUP BY 1)
      SELECT COALESCE(b.k,l.k) AS col,
             round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4) AS delta
      FROM b FULL OUTER JOIN l ON l.k = b.k
      WHERE round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4) <> 0
        AND COALESCE(b.k,l.k) NOT IN ('id','quantity','asin','seller_sku')
    LOOP
      IF r.col = 'compensated_clawback' THEN
        v_mclaw := v_mclaw + r.delta; v_mnet := v_mnet + r.delta;
      ELSIF r.col = ANY(v_rincome) THEN v_mnet := v_mnet + r.delta;
      ELSIF r.col = ANY(v_rexp)    THEN v_mnet := v_mnet - r.delta;
      ELSE v_unknown := v_unknown + 1;
      END IF;
    END LOOP;
    v_total := v_total + v_mnet;
    IF v_m >= '2026-02-01'::date THEN v_febsep := v_febsep + v_mnet; END IF;
    RAISE NOTICE '   % | % | % | % | %', to_char(v_m,'YYYY-MM'),
      lpad(round(v_mclaw,2)::text,10), lpad(round(v_mnet - v_mclaw,2)::text,11),
      lpad(round(v_mnet,2)::text,10), v_unknown;
  END LOOP;
  RAISE NOTICE '   -----------------------------------------------------------';
  RAISE NOTICE '   Feb-Sep (8 months)      : %', lpad(round(v_febsep,2)::text,10);
  RAISE NOTICE '   January (earlier stage) : %', lpad(round(v_total - v_febsep,2)::text,10);
  RAISE NOTICE '   ALL NINE APPLIED MONTHS : %', lpad(round(v_total,2)::text,10);

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, nothing fired.';
END
$p$;
