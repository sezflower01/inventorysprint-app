-- READ-ONLY PROBE: finish the gross-vs-net question the previous probe could
-- not answer, because the event_type='order' join matched nothing.
--
-- Two independent routes:
--
-- (A) ARITHMETIC, and it needs no join at all. Amazon defines a restocking fee
--     as a percentage OF THE ITEM PRICE. So if `refunds` holds the gross item
--     price, restock/refund lands on the tier exactly: 15.00 / 20.00 / 50.00.
--     If `refunds` were already NET of the fee, the same tiers would show up as
--     15/85 = 17.65, 20/80 = 25.00, 50/50 = 100.00 -- nowhere near.
--     The observed ratios therefore identify the base without any other table.
--
-- (B) The actual order row, once the real event_type label is known.
DO $$
DECLARE r record; on_tier int := 0; off_tier int := 0; net_tier int := 0;
BEGIN
  RAISE NOTICE '=== what event_type values exist? (the previous join assumed order) ===';
  FOR r IN
    SELECT event_type, count(*) AS rows,
           count(*) FILTER (WHERE coalesce(sales,0) <> 0) AS with_sales
    FROM financial_events_cache GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  % rows=% with_sales=%', r.event_type, r.rows, r.with_sales;
  END LOOP;

  RAISE NOTICE '=== (A) does every ratio sit ON a published tier, or on its net twin? ===';
  RAISE NOTICE '  gross bases: 15.00 / 20.00 / 50.00   net twins: 17.65 / 25.00 / 100.00';
  FOR r IN
    SELECT amazon_order_id,
           round((restocking_fee / nullif(refunds,0) * 100)::numeric, 2) AS pct
    FROM financial_events_cache WHERE restocking_fee <> 0
  LOOP
    IF r.pct BETWEEN 14.8 AND 15.2 OR r.pct BETWEEN 19.8 AND 20.2 OR r.pct BETWEEN 49.8 AND 50.2 THEN
      on_tier := on_tier + 1;
    ELSIF r.pct BETWEEN 17.4 AND 17.9 OR r.pct BETWEEN 24.8 AND 25.2 OR r.pct BETWEEN 99.5 AND 100.5 THEN
      net_tier := net_tier + 1;
      RAISE NOTICE '  NET-BASED: % at % percent', r.amazon_order_id, r.pct;
    ELSE
      off_tier := off_tier + 1;
      RAISE NOTICE '  OFF-TIER: % at % percent', r.amazon_order_id, r.pct;
    END IF;
  END LOOP;
  RAISE NOTICE '  >>> on a GROSS tier: %   on a NET twin: %   off-tier: %',
    on_tier, net_tier, off_tier;

  RAISE NOTICE '=== (B) refund vs the original sale, via sales_orders.order_id ===';
  FOR r IN
    SELECT f.amazon_order_id,
           round(f.restocking_fee::numeric,2) AS restock,
           round(f.refunds::numeric,2) AS refund_booked,
           round(sum(s.sold_price)::numeric,2) AS sold_usd,
           sum(s.quantity) AS qty
    FROM financial_events_cache f
    JOIN sales_orders s ON s.order_id = f.amazon_order_id
    WHERE f.restocking_fee <> 0
    GROUP BY f.amazon_order_id, f.restocking_fee, f.refunds
    ORDER BY f.amazon_order_id LIMIT 15
  LOOP
    RAISE NOTICE '  % | restock=% refund=% sold_usd=% qty=% | refund-sale=%',
      r.amazon_order_id, r.restock, r.refund_booked, r.sold_usd, r.qty,
      round((r.refund_booked - r.sold_usd)::numeric,2);
  END LOOP;
END $$;
