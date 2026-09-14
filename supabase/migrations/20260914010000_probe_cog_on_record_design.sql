-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Design input for "COG on record": one average unit cost per ASIN, typed by
-- the seller, that drives COGS for every sale from 2026-01-01 and re-prices
-- those sales whenever it is edited. Created Listings cost becomes reference
-- only. Decided with the seller 2026-09-14: 2026 onward, per ASIN, seeded once
-- from total spent / total units, then edited by hand.
--
-- The intended mechanism is WRITE-THROUGH: the COG is written into the cost
-- columns the reports already read (unit_cost, unit_cost_at_sale, total_cost),
-- so the P&L RPCs, Live Sales, mobile and Excel all agree with no reader
-- changes -- the failure mode that once put web and Excel $2,491.75 apart.
--
-- Questions that decide whether that is safe:
--   1. which derived money columns sit on sales_orders and must move with cost;
--   2. what triggers fire on sales_orders, since an edit rewrites many rows
--      inside an 8-second authenticated statement_timeout;
--   3. 2026 volume, and the largest per-ASIN rewrite an edit would cause;
--   4. how refund and cancelled rows carry cost, so their signs are preserved;
--   5. whether stored ROI can be re-derived from stored cost -- profit before
--      cost = total_cost x (1 + roi/100) -- instead of re-implementing the
--      currency-aware revenue logic in SQL;
--   6. what the seed would produce, and whether created_listing_purchases
--      duplicates created_listings lots (double counting in the average).

DO $probe$
DECLARE r record; v_uid uuid; v_cols text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. cost / profit columns on sales_orders ========';
  SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sales_orders'
    AND (column_name ~ '(cost|roi|profit|margin|cog)');
  RAISE NOTICE '  %', v_cols;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. triggers on sales_orders ========';
  FOR r IN
    SELECT t.tgname, p.proname,
           CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
           CASE WHEN t.tgtype & 1 = 1 THEN 'ROW' ELSE 'STMT' END AS lvl,
           concat_ws(',', CASE WHEN t.tgtype & 4 = 4 THEN 'INS' END,
                          CASE WHEN t.tgtype & 8 = 8 THEN 'DEL' END,
                          CASE WHEN t.tgtype & 16 = 16 THEN 'UPD' END) AS evts,
           t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.sales_orders'::regclass AND NOT t.tgisinternal
    ORDER BY t.tgname
  LOOP
    RAISE NOTICE '  % % % % en=% -> %', rpad(r.tgname, 44), r.timing, r.lvl, rpad(r.evts, 12), r.enabled, r.proname;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. 2026 volume (order_date >= 2026-01-01) ========';
  FOR r IN
    SELECT count(*) AS n,
           count(DISTINCT asin) AS asins,
           count(*) FILTER (WHERE cost_locked) AS locked,
           count(*) FILTER (WHERE order_id LIKE '%-REFUND') AS refunds,
           count(*) FILTER (WHERE order_status IN ('Canceled', 'Cancelled')) AS cancelled,
           count(*) FILTER (WHERE COALESCE(unit_cost, 0) <= 0) AS no_cost
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
  LOOP
    RAISE NOTICE '  rows=% asins=% locked=% refunds=% cancelled=% zero_cost=%',
      r.n, r.asins, r.locked, r.refunds, r.cancelled, r.no_cost;
  END LOOP;
  FOR r IN
    SELECT asin, count(*) AS n FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
    GROUP BY asin ORDER BY n DESC LIMIT 5
  LOOP
    RAISE NOTICE '  largest per-ASIN rewrite: % rows for %', r.n, r.asin;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. how refunds and cancels carry cost (2026) ========';
  FOR r IN
    SELECT CASE WHEN order_id LIKE '%-REFUND' THEN 'refund'
                WHEN order_status IN ('Canceled', 'Cancelled') THEN 'cancelled'
                ELSE 'sale' END AS kind,
           count(*) AS n,
           count(*) FILTER (WHERE quantity < 0) AS neg_qty,
           count(*) FILTER (WHERE quantity = 0) AS zero_qty,
           count(*) FILTER (WHERE total_cost < 0) AS neg_cost,
           count(*) FILTER (WHERE COALESCE(total_cost, 0) = 0) AS zero_cost,
           count(*) FILTER (WHERE total_cost > 0) AS pos_cost,
           count(*) FILTER (WHERE unit_cost > 0 AND quantity <> 0
                              AND abs(COALESCE(total_cost, 0) - unit_cost * quantity) > 0.02) AS total_ne_unit_x_qty
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % n=% qty<0:% qty=0:% cost<0:% cost=0:% cost>0:% total<>unit*qty:%',
      rpad(r.kind, 10), r.n, r.neg_qty, r.zero_qty, r.neg_cost, r.zero_cost, r.pos_cost, r.total_ne_unit_x_qty;
  END LOOP;
  FOR r IN
    SELECT order_id, quantity, unit_cost, unit_cost_at_sale, total_cost, roi, cost_locked, order_status
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01' AND order_id LIKE '%-REFUND'
    ORDER BY order_date DESC LIMIT 4
  LOOP
    RAISE NOTICE '  refund sample: % qty=% unit=% at_sale=% total=% roi=% locked=% status=%',
      r.order_id, r.quantity, r.unit_cost, r.unit_cost_at_sale, r.total_cost, r.roi, r.cost_locked, r.order_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. can ROI be re-derived from stored cost? (US sales, 2026) ========';
  RAISE NOTICE '  test: total_cost x (1 + roi/100) should equal sold_price x qty - total_fees';
  FOR r IN
    WITH s AS (
      SELECT total_cost, roi, sold_price, quantity, abs(COALESCE(total_fees, 0)) AS fees,
             total_cost * (1 + roi / 100.0) AS derived,
             sold_price * quantity - abs(COALESCE(total_fees, 0)) AS direct
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2026-01-01'
        AND COALESCE(marketplace, 'US') = 'US'
        AND order_id NOT LIKE '%-REFUND'
        AND total_cost > 0 AND roi IS NOT NULL AND sold_price > 0 AND quantity > 0
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE abs(derived - direct) <= 0.05) AS within_5c,
           count(*) FILTER (WHERE abs(derived - direct) <= 0.50) AS within_50c,
           count(*) FILTER (WHERE roi = 0) AS roi_zero
    FROM s
  LOOP
    RAISE NOTICE '  rows=% within 5c=% within 50c=% roi exactly 0=%',
      r.n, r.within_5c, r.within_50c, r.roi_zero;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 6. seed preview ========';
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'created_listing_purchases';
  RAISE NOTICE '  created_listing_purchases columns: %', COALESCE(v_cols, '(absent)');

  FOR r IN
    SELECT count(DISTINCT asin) AS asins,
           count(*) AS lots,
           sum(units) AS units,
           round(sum(cost)::numeric, 2) AS spent
    FROM public.created_listings
    WHERE user_id = v_uid AND cost > 0 AND units > 0
      AND asin IS NOT NULL AND asin NOT IN ('PENDING', 'UNKNOWN')
  LOOP
    RAISE NOTICE '  created_listings: % ASINs, % lots, % units, $% spent', r.asins, r.lots, r.units, r.spent;
  END LOOP;

  BEGIN
    FOR r IN
      SELECT count(*) AS n,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.created_listings l
               WHERE l.id = p.listing_id
                 AND abs(COALESCE(l.amount, 0) - p.unit_cost) < 0.01)) AS same_unit_as_listing
      FROM public.created_listing_purchases p
      WHERE p.user_id = v_uid
    LOOP
      RAISE NOTICE '  created_listing_purchases: % rows, % carry the same unit cost as their listing (possible double count)',
        r.n, r.same_unit_as_listing;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  created_listing_purchases unreadable: %', SQLERRM;
  END;

  FOR r IN
    WITH sold AS (
      SELECT DISTINCT asin FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2026-01-01' AND asin IS NOT NULL
    ), seedable AS (
      SELECT DISTINCT asin FROM public.created_listings
      WHERE user_id = v_uid AND cost > 0 AND units > 0
    )
    SELECT (SELECT count(*) FROM sold) AS sold_2026,
           (SELECT count(*) FROM sold WHERE asin IN (SELECT asin FROM seedable)) AS sold_and_seedable,
           (SELECT count(*) FROM sold WHERE asin NOT IN (SELECT asin FROM seedable)) AS sold_not_seedable
  LOOP
    RAISE NOTICE '  ASINs sold in 2026: % | seedable: % | no purchase record to seed from: %',
      r.sold_2026, r.sold_and_seedable, r.sold_not_seedable;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  seed vs current 2026 COGS, top 8 ASINs by 2026 COGS:';
  FOR r IN
    WITH seed AS (
      SELECT asin, sum(cost) / NULLIF(sum(units), 0) AS avg_unit, sum(units) AS units_bought, count(*) AS lots
      FROM public.created_listings
      WHERE user_id = v_uid AND cost > 0 AND units > 0
      GROUP BY asin
    ), cur AS (
      SELECT asin, sum(total_cost) AS cogs, sum(quantity) FILTER (WHERE order_id NOT LIKE '%-REFUND') AS qty
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2026-01-01'
        AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled')
      GROUP BY asin
    )
    SELECT cur.asin, round(cur.cogs::numeric, 2) AS cogs_now, cur.qty,
           round(seed.avg_unit::numeric, 2) AS seed_unit, seed.units_bought, seed.lots,
           round((seed.avg_unit * cur.qty)::numeric, 2) AS cogs_seeded
    FROM cur JOIN seed USING (asin)
    ORDER BY cur.cogs DESC NULLS LAST LIMIT 8
  LOOP
    RAISE NOTICE '    % now=$% qty=% seed=$%/unit (% units, % lots) -> ~$%',
      r.asin, r.cogs_now, r.qty, r.seed_unit, r.units_bought, r.lots, r.cogs_seeded;
  END LOOP;

  FOR r IN
    WITH seed AS (
      SELECT asin, sum(cost) / NULLIF(sum(units), 0) AS avg_unit
      FROM public.created_listings
      WHERE user_id = v_uid AND cost > 0 AND units > 0
      GROUP BY asin
    )
    SELECT round(sum(s.total_cost)::numeric, 2) AS now_total,
           round(sum(CASE WHEN seed.avg_unit IS NOT NULL
                          THEN seed.avg_unit * s.quantity ELSE s.total_cost END)::numeric, 2) AS seeded_total
    FROM public.sales_orders s
    LEFT JOIN seed ON seed.asin = s.asin
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
  LOOP
    RAISE NOTICE '  2026 COGS now $% -> roughly $% if seeded (sign conventions unverified here)',
      r.now_total, r.seeded_total;
  END LOOP;
END
$probe$;
