-- PHANTOM FBA FEES ON SELF-SHIPPED (MFN) 2026 ORDERS -- READ ONLY. 2026 ONLY.
--
-- Scope: 2026. Nothing before 2026-01-01 is read and nothing is written.
--
-- The claim to test: a self-shipped (MFN / FBM) order cannot owe an FBA
-- fulfillment fee, because Amazon did not fulfil it. Where one is stored, the
-- cost is phantom and whatever reads it overstates cost.
--
-- The question that actually decides whether it matters is the SECOND one:
-- DOES THE P&L READ IT? The P&L reads financial_events_cache.fba_fees, not
-- sales_orders.fba_fee -- two different tables with two different writers. So
-- a phantom fee on sales_orders can be real money on a per-order ROI screen
-- and simultaneously invisible to the monthly P&L, or the reverse. Both paths
-- are measured here, separately, and neither is inferred from the other.
--
-- Coverage caveat stated up front: fulfillment_channel was NULL on most of this
-- table until the 2026-10-19 rule-A backfill set MFN where shipping_label_fee
-- > 0 (migration 20261019150000). So "MFN" here means "known MFN", and a NULL
-- channel is unknown, not FBA. Every count below reports the NULL bucket too.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_mfn_fba numeric; v_mfn_rows int; v_fec_fba numeric; v_fec_rows int;
  v_label_so numeric; v_label_fec numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  -- 0. coverage: what do we actually know about the channel?
  ------------------------------------------------------------------
  RAISE NOTICE '############ 0. CHANNEL COVERAGE ON 2026 sales_orders ############';
  RAISE NOTICE '   channel  |   rows | units |     fba_fee |  label_fee | both > 0';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc,
           count(*) AS rows,
           sum(COALESCE(quantity,0)) AS units,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS label,
           count(*) FILTER (WHERE COALESCE(fba_fee,0) > 0
                              AND COALESCE(shipping_label_fee,0) > 0) AS both
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % | % | % | % | %', rpad(r.fc,8), lpad(r.rows::text,6),
      lpad(r.units::text,5), lpad(r.fba::text,11), lpad(r.label::text,10),
      lpad(r.both::text,8);
  END LOOP;

  ------------------------------------------------------------------
  -- 1. the phantom on sales_orders
  ------------------------------------------------------------------
  SELECT count(*), round(sum(COALESCE(fba_fee,0))::numeric,2)
    INTO v_mfn_rows, v_mfn_fba
  FROM public.sales_orders
  WHERE user_id = v_uid
    AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
    AND order_id NOT LIKE '%-REFUND%'
    AND fulfillment_channel = 'MFN' AND COALESCE(fba_fee,0) > 0;

  RAISE NOTICE '';
  RAISE NOTICE '############ 1. PHANTOM fba_fee ON KNOWN-MFN 2026 ROWS ############';
  RAISE NOTICE '   rows carrying one : %', v_mfn_rows;
  RAISE NOTICE '   fba_fee stored    : % (phantom -- Amazon did not fulfil these)',
    COALESCE(v_mfn_fba,0);
  RAISE NOTICE '';
  RAISE NOTICE '   by month, and where the fee came from:';
  RAISE NOTICE '   month | rows |  fba_fee | fees_source';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mo, count(*) AS rows,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba,
           string_agg(DISTINCT COALESCE(fees_source,'(null)'), ', ') AS srcs
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
      AND fulfillment_channel = 'MFN' AND COALESCE(fba_fee,0) > 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | %', r.mo, lpad(r.rows::text,4),
      lpad(r.fba::text,8), r.srcs;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  ------------------------------------------------------------------
  -- 2. DOES THE P&L READ IT? the cache side, for the same orders
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. DOES THE P&L READ THAT FEE? ############';
  RAISE NOTICE '   The P&L reads financial_events_cache.fba_fees. Same orders,';
  RAISE NOTICE '   other table:';

  SELECT count(*), round(sum(abs(COALESCE(f.fba_fees,0))),2)
    INTO v_fec_rows, v_fec_fba
  FROM public.financial_events_cache f
  WHERE f.user_id = v_uid
    AND f.event_date >= '2026-01-01' AND f.event_date < '2027-01-01'
    AND f.amazon_order_id IN (
      SELECT order_id FROM public.sales_orders
      WHERE user_id = v_uid
        AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
        AND fulfillment_channel = 'MFN' AND COALESCE(fba_fee,0) > 0);
  RAISE NOTICE '   cache rows for those orders : %', v_fec_rows;
  RAISE NOTICE '   fba_fees they carry         : %', COALESCE(v_fec_fba,0);
  IF COALESCE(v_fec_fba,0) = 0 THEN
    RAISE NOTICE '   >>> the P&L does NOT read this phantom. It is a per-order /';
    RAISE NOTICE '   >>> ROI-screen defect, not a P&L one.';
  ELSE
    RAISE NOTICE '   >>> the P&L DOES carry % of fba_fees on self-shipped orders.',
      COALESCE(v_fec_fba,0);
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   the wider question: ALL 2026 cache fba_fees whose order is';
  RAISE NOTICE '   known-MFN in sales_orders, regardless of what sales_orders stored:';
  FOR r IN
    SELECT COALESCE(so.fulfillment_channel,'(NULL)') AS fc,
           count(*) AS rows,
           round(sum(abs(COALESCE(f.fba_fees,0))),2) AS fba
    FROM public.financial_events_cache f
    LEFT JOIN (SELECT DISTINCT order_id, fulfillment_channel
               FROM public.sales_orders WHERE user_id = v_uid) so
           ON so.order_id = f.amazon_order_id
    WHERE f.user_id = v_uid
      AND f.event_date >= '2026-01-01' AND f.event_date < '2027-01-01'
      AND abs(COALESCE(f.fba_fees,0)) > 0
    GROUP BY 1 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '      channel % | % rows | fba_fees % | %', rpad(r.fc,8),
      lpad(r.rows::text,6), lpad(r.fba::text,11),
      CASE WHEN r.fc = 'MFN' THEN '>>> PHANTOM IN THE P&L'
           WHEN r.fc = '(NULL)' THEN 'channel unknown / not an order row'
           ELSE 'legitimate FBA' END;
  END LOOP;

  ------------------------------------------------------------------
  -- 3. the mirror image: the REAL MFN cost the P&L cannot see
  ------------------------------------------------------------------
  SELECT round(sum(COALESCE(shipping_label_fee,0))::numeric,2) INTO v_label_so
  FROM public.sales_orders
  WHERE user_id = v_uid
    AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
    AND order_id NOT LIKE '%-REFUND%';
  SELECT round(sum(abs(COALESCE(fbm_shipping_label_fee,0))),2) INTO v_label_fec
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';

  RAISE NOTICE '';
  RAISE NOTICE '############ 3. THE REAL MFN COST, AND WHETHER THE P&L SEES IT ############';
  RAISE NOTICE '   sales_orders.shipping_label_fee, 2026        : %', COALESCE(v_label_so,0);
  RAISE NOTICE '   financial_events_cache.fbm_shipping_label_fee: %', COALESCE(v_label_fec,0);
  RAISE NOTICE '   The P&L has a wired column for this and NO RowDef, because the';
  RAISE NOTICE '   cache value has always been 0 -- so a row would print 0.00 in';
  RAISE NOTICE '   every month. The money is real and tracked on sales_orders.';
  IF COALESCE(v_label_fec,0) = 0 AND COALESCE(v_label_so,0) > 0 THEN
    RAISE NOTICE '   >>> CONFIRMED for 2026: % of real self-shipped label cost is',
      COALESCE(v_label_so,0);
    RAISE NOTICE '   >>> absent from Net Profit, which therefore OVERSTATES profit';
    RAISE NOTICE '   >>> by that amount. This is far larger than the phantom above.';
  END IF;

  ------------------------------------------------------------------
  -- 4. is the referral_fees netting legitimate? (from the 1300 run)
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. REFERRAL FEE NETTING -- deliberate or hiding something? ############';
  RAISE NOTICE '   The P&L reports ABS(SUM(signed referral_fees)), which differed';
  RAISE NOTICE '   from SUM(ABS(per row)) by 11,030.38 across 2026. If the negative';
  RAISE NOTICE '   rows are referral fees REFUNDED on returns, netting is correct.';
  RAISE NOTICE '   event_type | sign | rows |  magnitude';
  FOR r IN
    SELECT event_type AS et,
           CASE WHEN referral_fees < 0 THEN 'negative' ELSE 'positive' END AS sgn,
           count(*) AS rows, round(sum(abs(referral_fees)),2) AS magn
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      AND COALESCE(referral_fees,0) <> 0
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '   % | % | % | %', rpad(COALESCE(r.et,'(null)'),10),
      rpad(r.sgn,8), lpad(r.rows::text,4), lpad(r.magn::text,11);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   and the negative `reimbursements` rows the P&L nets away';
  RAISE NOTICE '   (May and June only, from the 1300 run):';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS mo, event_type AS et, count(*) AS rows,
           round(sum(reimbursements),2) AS tot
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      AND COALESCE(reimbursements,0) < 0
    GROUP BY 1,2 ORDER BY 1
  LOOP
    RAISE NOTICE '      % | % | % rows | %', r.mo, rpad(COALESCE(r.et,'(null)'),10),
      lpad(r.rows::text,3), lpad(r.tot::text,9);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, nothing fired.';
END
$p$;
