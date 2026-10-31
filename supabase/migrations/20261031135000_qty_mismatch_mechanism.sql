-- WHICH DEFECT IS IT? -- READ ONLY. 2026 ONLY.
--
-- Two of 59 sampled orders disagree with Amazon, both in the same direction:
--   701-3673086-3533855  stored 2, Amazon shipped 4
--   112-5072820-4704241  stored 2, Amazon shipped 11
--
-- The sample was restricted to orders with exactly ONE sales_orders row, on the
-- reasoning that getOrder's NumberOfItemsShipped covers the whole order and so
-- is only comparable when the order is one line. But "one row in sales_orders"
-- does NOT prove "one line at Amazon" -- it equally fits an order whose other
-- lines were never ingested. So there are two very different defects behind the
-- same number:
--
--   (a) WRONG QUANTITY -- one ASIN, Amazon shipped 11, we stored 2.
--       COGS understated on 9 units, revenue probably understated too.
--   (b) MISSING LINE ITEM -- the order had more ASINs and we stored one.
--       Worse: a whole line of revenue AND cost is absent.
--
-- financial_events_cache settles it without another Amazon call: Amazon's own
-- money rows per order carry one row per ASIN, so counting distinct ASINs there
-- against sales_orders distinguishes (a) from (b) directly.
DO $p$
DECLARE r record; v_uid uuid;
  v_oids text[] := ARRAY['701-3673086-3533855','112-5072820-4704241'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '############ 1. WHAT sales_orders HOLDS ############';
  FOR r IN
    SELECT order_id, order_date, asin, seller_sku, quantity AS qty,
           round(COALESCE(sold_price,0)::numeric,2) AS price,
           round(COALESCE(fba_fee,0)::numeric,2) AS fba,
           round(COALESCE(referral_fee,0)::numeric,2) AS ref,
           COALESCE(fulfillment_channel,'(NULL)') AS fc,
           COALESCE(order_status,'(NULL)') AS st,
           COALESCE(price_confidence,'-') AS conf
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = ANY(v_oids)
    ORDER BY order_id, asin
  LOOP
    RAISE NOTICE '   % | % | % | sku % | qty % | price % | fba % | ref % | % | % | %',
      r.order_id, r.order_date, rpad(r.asin,12), rpad(COALESCE(r.seller_sku,'-'),18),
      lpad(r.qty::text,3), lpad(r.price::text,8), lpad(r.fba::text,6),
      lpad(r.ref::text,6), r.fc, r.st, r.conf;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '############ 2. WHAT AMAZON''S MONEY ROWS HOLD ############';
  RAISE NOTICE '   one financial_events_cache row per ASIN per event';
  FOR r IN
    SELECT amazon_order_id AS oid, event_type AS et, event_date,
           COALESCE(asin,'(null)') AS asin, COALESCE(seller_sku,'-') AS sku,
           COALESCE(quantity,0) AS qty,
           round(COALESCE(sales,0),2) AS sales,
           round(COALESCE(referral_fees,0),2) AS ref,
           round(COALESCE(fba_fees,0),2) AS fba,
           COALESCE(marketplace,'(null)') AS mp
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND amazon_order_id = ANY(v_oids)
    ORDER BY amazon_order_id, event_date, asin
  LOOP
    RAISE NOTICE '   % | % | % | % | sku % | qty % | sales % | ref % | fba % | %',
      r.oid, rpad(r.et,10), r.event_date, rpad(r.asin,12), rpad(r.sku,18),
      lpad(r.qty::text,3), lpad(r.sales::text,9), lpad(r.ref::text,8),
      lpad(r.fba::text,7), r.mp;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '############ 3. THE VERDICT PER ORDER ############';
  FOR r IN
    SELECT o.oid,
           (SELECT count(DISTINCT asin) FROM public.sales_orders
             WHERE user_id=v_uid AND order_id=o.oid) AS so_asins,
           (SELECT sum(quantity) FROM public.sales_orders
             WHERE user_id=v_uid AND order_id=o.oid) AS so_units,
           (SELECT round(sum(COALESCE(sold_price,0))::numeric,2) FROM public.sales_orders
             WHERE user_id=v_uid AND order_id=o.oid) AS so_money,
           (SELECT count(DISTINCT asin) FROM public.financial_events_cache
             WHERE user_id=v_uid AND amazon_order_id=o.oid
               AND event_type='shipment') AS fec_asins,
           (SELECT sum(COALESCE(quantity,0)) FROM public.financial_events_cache
             WHERE user_id=v_uid AND amazon_order_id=o.oid
               AND event_type='shipment') AS fec_units,
           (SELECT round(sum(abs(COALESCE(sales,0))),2) FROM public.financial_events_cache
             WHERE user_id=v_uid AND amazon_order_id=o.oid
               AND event_type='shipment') AS fec_money
    FROM unnest(v_oids) AS o(oid)
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   %', r.oid;
    RAISE NOTICE '      sales_orders : % ASIN(s) | % units | % revenue',
      r.so_asins, r.so_units, COALESCE(r.so_money,0);
    RAISE NOTICE '      Amazon money : % ASIN(s) | % units | % revenue',
      r.fec_asins, COALESCE(r.fec_units,0), COALESCE(r.fec_money,0);
    IF COALESCE(r.fec_asins,0) > COALESCE(r.so_asins,0) THEN
      RAISE NOTICE '      >>> MISSING LINE ITEM: Amazon billed % ASINs, we stored %.',
        r.fec_asins, r.so_asins;
      RAISE NOTICE '      >>> A whole line of revenue AND cost is absent from';
      RAISE NOTICE '      >>> sales_orders. This is NOT a quantity bug.';
    ELSIF COALESCE(r.fec_units,0) > COALESCE(r.so_units,0) THEN
      RAISE NOTICE '      >>> WRONG QUANTITY: same ASIN count, Amazon counts % units',
        r.fec_units;
      RAISE NOTICE '      >>> against our %. COGS understated on % units.',
        r.so_units, COALESCE(r.fec_units,0) - COALESCE(r.so_units,0);
    ELSIF COALESCE(r.fec_units,0) = COALESCE(r.so_units,0)
      AND COALESCE(r.fec_units,0) > 0 THEN
      RAISE NOTICE '      >>> sales_orders AGREES with Amazon''s money rows.';
      RAISE NOTICE '      >>> So the getOrder figure is the outlier -- most likely';
      RAISE NOTICE '      >>> NumberOfItemsShipped counting units Amazon later';
      RAISE NOTICE '      >>> cancelled, replaced or re-shipped free of charge.';
      RAISE NOTICE '      >>> NO COGS effect: the money rows are what COGS follows.';
    ELSE
      RAISE NOTICE '      >>> no shipment money rows to compare against.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   NOTE on the 429: one of the 60 came back HTTP 429 (Amazon';
  RAISE NOTICE '   throttled it), so 59 were compared, not 60. A 429 is a';
  RAISE NOTICE '   missing answer, not a match.';
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written.';
END
$p$;
