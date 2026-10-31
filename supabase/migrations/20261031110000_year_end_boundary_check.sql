-- YEAR-END BOUNDARY CHECK -- READ ONLY. Nothing is written, nothing is fired.
--
-- The question: financial_events_cache.event_date is AdjustmentEvent.PostedDate
-- truncated to a UTC calendar day (see the COMMENT added in 20261022050000).
-- Amazon's own reports, and InventoryLab, file by Pacific. Pacific is UTC-8, so
-- every row posted between 00:00 and 08:00 UTC belongs to the PREVIOUS Pacific
-- day -- and when that UTC day is the 1st of a month, the row belongs to the
-- previous MONTH; when it is 1 January, to the previous YEAR.
--
-- This is the same class of defect as sales_orders' two date fields (order_date
-- Pacific, purchase_timestamp_utc UTC, 23% landing on different days), but it is
-- a DIFFERENT table, so nothing there can be reused as evidence here.
--
-- First question, before any number is quoted: posted_at was added 2026-10-22
-- and backfilled only by the adjustment capture work. If the shipment, refund
-- and service_fee rows have no posted_at, the boundary cannot be measured for
-- them from this table at all, and saying so is the finding -- not quietly
-- reporting the adjustment-only answer as though it covered all four types.
DO $p$
DECLARE r record; v_uid uuid; v_has_posted boolean; v_n int; v_tot numeric;
        v_moving int := 0; v_money numeric := 0;
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

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='financial_events_cache'
                   AND column_name='posted_at') INTO v_has_posted;
  RAISE NOTICE '== 0. does posted_at exist? % ==', v_has_posted;
  IF NOT v_has_posted THEN
    RAISE NOTICE '   no posted_at column -- the boundary CANNOT be measured. Stop.';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 0a. posted_at COVERAGE by event_type, all of 2025-2026 ==';
  RAISE NOTICE '   type           |    rows | with posted_at |   pct | earliest posted';
  FOR r IN
    SELECT event_type AS et, count(*) AS rows, count(posted_at) AS with_posted,
           round(100.0*count(posted_at)/greatest(count(*),1),1) AS pct,
           to_char(min(posted_at),'YYYY-MM-DD') AS earliest
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date >= '2025-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % | % | % | %', rpad(r.et,14), lpad(r.rows::text,7),
      lpad(r.with_posted::text,14), lpad(r.pct::text,5), COALESCE(r.earliest,'-');
  END LOOP;
  RAISE NOTICE '   a type at 0.0 pct cannot be boundary-checked from this table --';
  RAISE NOTICE '   its event_date is all that was ever stored.';

  RAISE NOTICE '';
  RAISE NOTICE '== 0b. coverage by month, adjustments only ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m, count(*) AS rows,
           count(posted_at) AS with_posted
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2025-11-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows | % with posted_at', r.m,
         lpad(r.rows::text,5), lpad(r.with_posted::text,5); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. THE YEAR BOUNDARY: every row posted 2025-12-31 or 2026-01-01 UTC ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND posted_at >= '2025-12-31 00:00:00+00'
    AND posted_at < '2026-01-02 00:00:00+00';
  RAISE NOTICE '   rows with posted_at in that 48h window: %', v_n;
  IF v_n = 0 THEN
    RAISE NOTICE '   NONE -- either nothing posted in that window, or (far more';
    RAISE NOTICE '   likely) posted_at was never backfilled that far back. Check 0b.';
  END IF;
  FOR r IN
    SELECT event_type AS et, event_date AS ed,
           to_char(posted_at,'YYYY-MM-DD HH24:MI') AS utc,
           to_char(posted_at AT TIME ZONE 'America/Los_Angeles','YYYY-MM-DD HH24:MI') AS pac,
           (posted_at AT TIME ZONE 'America/Los_Angeles')::date AS pac_day
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND posted_at >= '2025-12-31 00:00:00+00'
      AND posted_at < '2026-01-02 00:00:00+00'
    ORDER BY posted_at
  LOOP
    RAISE NOTICE '   % | event_date % | UTC % | PAC % | pac day % | %',
      rpad(r.et,12), r.ed, r.utc, r.pac, r.pac_day,
      CASE WHEN r.pac_day = r.ed THEN 'same bucket'
           ELSE 'WOULD MOVE to ' || to_char(r.pac_day,'YYYY-MM') END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. EVERY row whose Pacific day differs from its event_date ==';
  RAISE NOTICE '   (posted_at present only; 00:00-08:00 UTC is the previous Pacific day)';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND posted_at IS NOT NULL
    AND (posted_at AT TIME ZONE 'America/Los_Angeles')::date <> event_date;
  RAISE NOTICE '   rows that would re-bucket by DAY: %', v_n;
  FOR r IN
    SELECT event_type AS et, count(*) AS n
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND posted_at IS NOT NULL
      AND (posted_at AT TIME ZONE 'America/Los_Angeles')::date <> event_date
    GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '      % | % rows', rpad(r.et,12), lpad(r.n::text,5); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. rows that would cross a MONTH boundary ==';
  SELECT count(*) INTO v_moving FROM public.financial_events_cache
  WHERE user_id=v_uid AND posted_at IS NOT NULL
    AND date_trunc('month',(posted_at AT TIME ZONE 'America/Los_Angeles')::date)
        <> date_trunc('month',event_date);
  RAISE NOTICE '   rows crossing a month boundary: %', v_moving;
  IF v_moving = 0 THEN
    RAISE NOTICE '   none -- no monthly figure would change, for the rows that HAVE posted_at';
  END IF;
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS from_m,
           to_char((posted_at AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM') AS to_m,
           event_type AS et, count(*) AS n
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND posted_at IS NOT NULL
      AND date_trunc('month',(posted_at AT TIME ZONE 'America/Los_Angeles')::date)
          <> date_trunc('month',event_date)
    GROUP BY 1,2,3 ORDER BY 1,2,3
  LOOP RAISE NOTICE '      % -> % | % | % rows', r.from_m, r.to_m, rpad(r.et,12), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. MONEY on the rows that would cross a month boundary ==';
  FOR r IN
    WITH moving AS (
      SELECT t.*, to_char(t.event_date,'YYYY-MM') AS from_m,
             to_char((t.posted_at AT TIME ZONE 'America/Los_Angeles')::date,'YYYY-MM') AS to_m
      FROM public.financial_events_cache t
      WHERE t.user_id=v_uid AND t.posted_at IS NOT NULL
        AND date_trunc('month',(t.posted_at AT TIME ZONE 'America/Los_Angeles')::date)
            <> date_trunc('month',t.event_date))
    SELECT m.from_m, m.to_m, e.k AS col, round(sum(e.v::numeric),2) AS amt
    FROM moving m, LATERAL jsonb_each_text(to_jsonb(m)) AS e(k,v)
    WHERE e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND e.k NOT IN ('id','quantity','asin','seller_sku','from_m','to_m')
      AND sign(e.v::numeric) <> 0
    GROUP BY 1,2,3 HAVING round(sum(e.v::numeric),2) <> 0
    ORDER BY 1,2,3
  LOOP
    RAISE NOTICE '      % -> % | % | %', r.from_m, r.to_m, rpad(r.col,28),
      lpad(r.amt::text,10);
    IF    r.col = 'compensated_clawback' THEN v_money := v_money + r.amt;
    ELSIF r.col = ANY(v_rincome) THEN v_money := v_money + r.amt;
    ELSIF r.col = ANY(v_rexp)    THEN v_money := v_money - r.amt;
    END IF;
  END LOOP;
  RAISE NOTICE '   net profit that would move between months: %', round(v_money,2);
  IF v_moving = 0 THEN
    RAISE NOTICE '   (zero, necessarily -- no row crosses a boundary)';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. how far back posted_at actually reaches ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND posted_at IS NOT NULL;
  SELECT count(*) INTO v_tot FROM public.financial_events_cache WHERE user_id=v_uid;
  RAISE NOTICE '   rows with posted_at: % of % total', v_n, v_tot;
  FOR r IN
    SELECT to_char(min(posted_at),'YYYY-MM-DD HH24:MI') AS lo,
           to_char(max(posted_at),'YYYY-MM-DD HH24:MI') AS hi
    FROM public.financial_events_cache WHERE user_id=v_uid AND posted_at IS NOT NULL
  LOOP RAISE NOTICE '   posted_at spans % .. %', COALESCE(r.lo,'-'), COALESCE(r.hi,'-'); END LOOP;
  RAISE NOTICE '   the 2025/2026 year boundary is inside that span only if lo < 2025-12-31.';

  RAISE NOTICE '';
  RAISE NOTICE '== 6. THE NINE-MONTH NET TABLE, each month from its own backup ==';
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
      ELSE
        v_unknown := v_unknown + 1;
        RAISE NOTICE '      % UNKNOWN COLUMN % delta %', to_char(v_m,'YYYY-MM'), r.col, r.delta;
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
  RAISE NOTICE '   clawback lines alone would say -2046.17 for 2026 incl. October';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, nothing fired.';
END
$p$;
