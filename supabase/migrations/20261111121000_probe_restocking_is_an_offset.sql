-- READ-ONLY PROBE: is the restocking fee EXTRA income, or an OFFSET to a
-- refund booked at gross?
--
-- Every sampled restocking event is almost exactly 20% of the refund beside
-- it, which is Amazon's standard restocking percentage. That points at a
-- specific mechanism: Amazon withholds the fee from the BUYER's refund and
-- credits it to the seller. If so the money never left the seller, and the
-- only reason it needs an income line is that the refund is booked GROSS.
--
-- The test: does `refunds` equal the ORIGINAL SALE (gross), or the smaller
-- amount the buyer actually got back (net of the fee)?
--   gross -> restocking_fee is a mandatory offset. Moving it to charges would
--            double-count the fee and overstate the loss.
--   net   -> restocking_fee is genuine extra income and is double-counted NOW.
--
-- Compared against the ORDER row in financial_events_cache rather than
-- sales_orders on purpose: same table, same ingest path, same USD basis, and
-- it sidesteps sales_orders' unit-vs-line-total ambiguity (see the
-- line-total-stored-as-unit-price incident) which would otherwise be
-- indistinguishable from the thing being measured.
DO $$
DECLARE r record; n_gross int := 0; n_net int := 0; n_unclear int := 0; n_nosale int := 0;
BEGIN
  RAISE NOTICE '=== 1. exact restocking / refund ratio ===';
  FOR r IN
    SELECT event_date, amazon_order_id,
           round(restocking_fee::numeric,2) AS restock,
           round(refunds::numeric,2) AS refund,
           round((restocking_fee / nullif(refunds,0) * 100)::numeric, 2) AS pct
    FROM financial_events_cache
    WHERE restocking_fee <> 0
    ORDER BY event_date
  LOOP
    RAISE NOTICE '  % | % | restock=% refund=% ratio=% percent',
      r.event_date, r.amazon_order_id, r.restock, r.refund, r.pct;
  END LOOP;

  RAISE NOTICE '=== 2. refund vs the ORIGINAL sale: gross, or net of the fee? ===';
  FOR r IN
    SELECT f.amazon_order_id,
           round(f.restocking_fee::numeric,2) AS restock,
           round(f.refunds::numeric,2) AS refund_booked,
           round(o.sold::numeric,2) AS sold_for,
           round((f.refunds - o.sold)::numeric,2) AS refund_minus_sale
    FROM financial_events_cache f
    LEFT JOIN (
      SELECT amazon_order_id, sum(sales) AS sold
      FROM financial_events_cache
      WHERE event_type = 'order'
      GROUP BY amazon_order_id
    ) o ON o.amazon_order_id = f.amazon_order_id
    WHERE f.restocking_fee <> 0
    ORDER BY f.amazon_order_id
  LOOP
    IF r.sold_for IS NULL THEN
      n_nosale := n_nosale + 1;
      RAISE NOTICE '  % NO SALE ROW: refund booked %, restock % (order row pruned)',
        r.amazon_order_id, r.refund_booked, r.restock;
    ELSIF abs(r.refund_minus_sale) < 0.02 THEN
      n_gross := n_gross + 1;
      RAISE NOTICE '  % GROSS: sold %, refund booked % (= sale), restock % -> real cost %',
        r.amazon_order_id, r.sold_for, r.refund_booked, r.restock,
        round((r.refund_booked - r.restock)::numeric,2);
    ELSIF abs(r.refund_minus_sale + r.restock) < 0.02 THEN
      n_net := n_net + 1;
      RAISE NOTICE '  % NET: sold %, refund booked % = sale minus restock % -- DOUBLE COUNTED',
        r.amazon_order_id, r.sold_for, r.refund_booked, r.restock;
    ELSE
      n_unclear := n_unclear + 1;
      RAISE NOTICE '  % UNCLEAR: sold %, refund booked %, restock %, diff %',
        r.amazon_order_id, r.sold_for, r.refund_booked, r.restock, r.refund_minus_sale;
    END IF;
  END LOOP;

  RAISE NOTICE '=== VERDICT: gross=% net=% unclear=% no_sale_row=% ===',
    n_gross, n_net, n_unclear, n_nosale;
  IF n_net > 0 THEN
    RAISE NOTICE '  >>> % order(s) book the refund NET -- the fee is counted twice there.', n_net;
  END IF;
  IF n_gross > 0 AND n_net = 0 THEN
    RAISE NOTICE '  >>> Refunds are booked GROSS. The income line is a REQUIRED offset,';
    RAISE NOTICE '  >>> not a windfall. Moving it to charges would overstate the loss.';
  END IF;
END $$;
