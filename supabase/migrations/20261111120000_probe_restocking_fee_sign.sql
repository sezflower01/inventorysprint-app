-- READ-ONLY PROBE: is "Restocking Fee" really seller INCOME, or a misfiled charge?
--
-- The seller sees it in the P&L income section at $68.36 for 2026 and asks why
-- it is not an Amazon charge. fetch-profit-loss/index.ts asserts in a comment
-- that the BUYER is charged the penalty and the SELLER keeps it, so it is
-- income -- but a comment is not evidence. settlement_line_items is, because
-- those rows are Amazon's own settlement reports: the money that actually
-- reached the bank. A POSITIVE amount there is a credit TO the seller; a
-- negative one is a deduction.
DO $$
DECLARE r record; n int; tot numeric;
BEGIN
  RAISE NOTICE '=== 1. financial_events_cache: restocking_fee by month, 2026 ===';
  FOR r IN
    SELECT to_char(date_trunc('month', event_date), 'YYYY-MM') AS mon,
           count(*) AS rows, round(sum(restocking_fee)::numeric, 2) AS total
    FROM financial_events_cache
    WHERE restocking_fee <> 0 AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % rows=% restocking=%', r.mon, r.rows, r.total;
  END LOOP;

  SELECT round(sum(restocking_fee)::numeric,2) INTO tot FROM financial_events_cache
  WHERE event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '  2026 TOTAL = % (seller reports $68.36 on screen)', tot;

  RAISE NOTICE '  --- are any stored NEGATIVE? (ingest takes abs(), so expect none) ---';
  SELECT count(*) INTO n FROM financial_events_cache WHERE restocking_fee < 0;
  RAISE NOTICE '  negative restocking_fee rows: %', n;

  RAISE NOTICE '=== 2. settlement_line_items: what Amazon actually settled ===';
  RAISE NOTICE '  (positive amount = credit TO seller, negative = deducted FROM seller)';
  FOR r IN
    SELECT coalesce(amount_type,'(null)') AS atype,
           coalesce(amount_description,'(null)') AS adesc,
           coalesce(transaction_type,'(null)') AS ttype,
           count(*) AS rows,
           count(*) FILTER (WHERE amount > 0) AS positive,
           count(*) FILTER (WHERE amount < 0) AS negative,
           round(sum(amount)::numeric, 2) AS net,
           round(min(amount)::numeric, 2) AS smallest,
           round(max(amount)::numeric, 2) AS largest
    FROM settlement_line_items
    WHERE lower(coalesce(amount_description,'') || ' ' || coalesce(amount_type,'') || ' ' || coalesce(fee_type,'')) LIKE '%restock%'
    GROUP BY 1,2,3 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '  type=% | desc=% | txn=% | rows=% pos=% neg=% net=% range %..%',
      r.atype, r.adesc, r.ttype, r.rows, r.positive, r.negative, r.net, r.smallest, r.largest;
  END LOOP;

  SELECT count(*) INTO n FROM settlement_line_items
  WHERE lower(coalesce(amount_description,'') || ' ' || coalesce(amount_type,'') || ' ' || coalesce(fee_type,'')) LIKE '%restock%';
  IF n = 0 THEN
    RAISE NOTICE '  NO restocking rows in settlement_line_items (90-day retention may have pruned them)';
  END IF;

  RAISE NOTICE '=== 3. sample individual restocking events, with the refund beside them ===';
  RAISE NOTICE '  A restocking fee should ALWAYS sit on a refund -- it is a penalty on a return.';
  FOR r IN
    SELECT event_date, amazon_order_id, asin,
           round(restocking_fee::numeric,2) AS restock,
           round(refunds::numeric,2) AS refund,
           round(fba_customer_return_fees::numeric,2) AS return_fee,
           event_type
    FROM financial_events_cache
    WHERE restocking_fee <> 0
    ORDER BY event_date DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % | % | % | restock=% refund=% return_fee=% type=%',
      r.event_date, r.amazon_order_id, r.asin, r.restock, r.refund, r.return_fee, r.event_type;
  END LOOP;

  RAISE NOTICE '=== 4. does a restocking fee ever appear WITHOUT a refund? ===';
  SELECT count(*) INTO n FROM financial_events_cache WHERE restocking_fee <> 0 AND coalesce(refunds,0) = 0;
  RAISE NOTICE '  restocking with no refund on the same row: % (should be ~0)', n;
END $$;
