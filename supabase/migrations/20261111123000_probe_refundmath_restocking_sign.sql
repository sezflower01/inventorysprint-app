-- READ-ONLY PROBE: does refundMath's `full` mode add the restocking fee as a
-- COST when it is actually a CREDIT?
--
-- src/lib/sales/refundMath.ts documents its convention explicitly:
--   principal          -> POSITIVE cost
--   referralFeesSigned -> credit (negative) reduces cost
-- and then in `full` mode does  signedSum += n(r.restocking_fee).
--
-- We have already established that restocking_fee is stored POSITIVE (abs() at
-- ingest, 0 negative rows) and that it is money the seller KEEPS -- the P&L
-- books it in INCOME_ROWS, and RefundsSection.tsx negates it as a credit.
-- If the convention is "positive = cost", adding a positive credit inflates
-- the refund cost by twice the fee's worth of error.
--
-- But that only holds if the other `full`-mode extras really are stored with
-- the sign the convention implies. If fba_fees and reversal_reimbursement come
-- back NEGATIVE on refund rows, the convention is confirmed and restocking_fee
-- is the odd one out. If they are positive too, the convention is not what the
-- comment says and the whole block needs reading differently.
--
-- `full` mode is not a corner: LiveSales, MobileLiveSales, PeriodStatsBlocks
-- and fetchCanonicalRefunds all use it.
DO $$
DECLARE r record; tot_restock numeric; n_refund_rows int;
BEGIN
  RAISE NOTICE '=== stored sign of each full-mode extra, on refund rows only ===';
  RAISE NOTICE '  (convention per the file: POSITIVE = cost, NEGATIVE = credit)';
  FOR r IN
    SELECT col, pos, neg, zero, round(net::numeric,2) AS net FROM (
      VALUES
        ('refunds',                 (SELECT count(*) FILTER (WHERE refunds>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE refunds<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(refunds,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(refunds) FROM financial_events_cache WHERE event_type='refund')),
        ('referral_fees',           (SELECT count(*) FILTER (WHERE referral_fees>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE referral_fees<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(referral_fees,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(referral_fees) FROM financial_events_cache WHERE event_type='refund')),
        ('fba_fees',                (SELECT count(*) FILTER (WHERE fba_fees>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE fba_fees<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(fba_fees,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(fba_fees) FROM financial_events_cache WHERE event_type='refund')),
        ('fba_customer_return_fees',(SELECT count(*) FILTER (WHERE fba_customer_return_fees>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE fba_customer_return_fees<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(fba_customer_return_fees,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(fba_customer_return_fees) FROM financial_events_cache WHERE event_type='refund')),
        ('restocking_fee',          (SELECT count(*) FILTER (WHERE restocking_fee>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE restocking_fee<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(restocking_fee,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(restocking_fee) FROM financial_events_cache WHERE event_type='refund')),
        ('reversal_reimbursement',  (SELECT count(*) FILTER (WHERE reversal_reimbursement>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE reversal_reimbursement<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(reversal_reimbursement,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(reversal_reimbursement) FROM financial_events_cache WHERE event_type='refund')),
        ('other_fees',              (SELECT count(*) FILTER (WHERE other_fees>0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE other_fees<0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT count(*) FILTER (WHERE coalesce(other_fees,0)=0) FROM financial_events_cache WHERE event_type='refund'),
                                    (SELECT sum(other_fees) FROM financial_events_cache WHERE event_type='refund'))
    ) AS t(col,pos,neg,zero,net)
  LOOP
    RAISE NOTICE '  %: positive=% negative=% zero=% net=%', r.col, r.pos, r.neg, r.zero, r.net;
  END LOOP;

  SELECT count(*) INTO n_refund_rows FROM financial_events_cache WHERE event_type='refund';
  SELECT round(sum(restocking_fee)::numeric,2) INTO tot_restock
  FROM financial_events_cache WHERE event_type='refund';
  RAISE NOTICE '=== blast radius ===';
  RAISE NOTICE '  refund rows total: %', n_refund_rows;
  RAISE NOTICE '  lifetime restocking_fee on refund rows: %', tot_restock;
  RAISE NOTICE '  if the sign is wrong, refund cost on every `full`-mode screen';
  RAISE NOTICE '  is overstated by 2x that (% ) -- once for not crediting it,', round(tot_restock*2, 2);
  RAISE NOTICE '  once for charging it.';
END $$;
