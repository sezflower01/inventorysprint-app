-- READ-ONLY. Items 4, 5, 6.
--
-- Item 4 note up front: the "about -$7,485 on 21 rows" I predicted was WRONG
-- as a statement about displayed numbers. Those 21 rows only flow through
-- PeriodStatsBlocks, and that component is not imported by any page -- the
-- single reference to it is `import type { PeriodStat }`, which is erased at
-- build time. So no page total changes by that amount. The real display impact
-- is confined to the two LIVE components: CancelledOrdersSection (rendered by
-- LiveSales and MobileLiveSales) and LiveSalesPopup (rendered by
-- AssignmentsTable).
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== ITEM 4a. CancelledOrdersSection: before vs after, TODAY ==';
  RAISE NOTICE '   before: abs(estimated_price ?? sold_price ?? total_sale_amount), unconverted';
  RAISE NOTICE '   after : getCancelledLineUsd -> estimate converted by marketplace';
  FOR r IN
    SELECT COALESCE(so.marketplace,'US') AS mk, count(*) AS rows,
           round(sum(abs(COALESCE(so.estimated_price, so.sold_price, so.total_sale_amount, 0)))::numeric,2) AS before_shown,
           round(sum(abs(CASE
             WHEN COALESCE(so.estimated_price,0) > 0
               THEN so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1)
             WHEN COALESCE(so.sold_price,0) > 0 THEN so.sold_price * GREATEST(so.quantity,1)
             ELSE COALESCE(so.total_sale_amount,0) END))::numeric,2) AS after_usd
    FROM public.sales_orders so
    LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND so.order_date = CURRENT_DATE
      AND (so.is_cancelled = true OR so.order_status IN ('Canceled','Cancelled'))
      AND so.order_id NOT LIKE '%-REFUND'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | before % | after % | change %',
      rpad(r.mk,3), lpad(r.rows::text,4), lpad(r.before_shown::text,10),
      lpad(r.after_usd::text,9), round((r.after_usd - r.before_shown)::numeric,2);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no cancelled orders today)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 4b. CancelledOrdersSection: LAST 7 DAYS ==';
  FOR r IN
    SELECT COALESCE(so.marketplace,'US') AS mk, count(*) AS rows,
           round(sum(abs(COALESCE(so.estimated_price, so.sold_price, so.total_sale_amount, 0)))::numeric,2) AS before_shown,
           round(sum(abs(CASE
             WHEN COALESCE(so.estimated_price,0) > 0
               THEN so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1)
             WHEN COALESCE(so.sold_price,0) > 0 THEN so.sold_price * GREATEST(so.quantity,1)
             ELSE COALESCE(so.total_sale_amount,0) END))::numeric,2) AS after_usd
    FROM public.sales_orders so
    LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND so.order_date >= CURRENT_DATE - 7
      AND (so.is_cancelled = true OR so.order_status IN ('Canceled','Cancelled'))
      AND so.order_id NOT LIKE '%-REFUND'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | before % | after % | change %',
      rpad(r.mk,3), lpad(r.rows::text,4), lpad(r.before_shown::text,10),
      lpad(r.after_usd::text,9), round((r.after_usd - r.before_shown)::numeric,2);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no cancelled orders in 7 days)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 4c. LiveSalesPopup: non-US rows it reads, last 7 days ==';
  RAISE NOTICE '   before: settled rows came out 18x LOW (USD divided again),';
  RAISE NOTICE '           pending rows came out 18x HIGH';
  FOR r IN
    SELECT so.marketplace AS mk,
           count(*) FILTER (WHERE COALESCE(so.total_sale_amount,0) > 0 OR COALESCE(so.sold_price,0) > 0) AS settled_rows,
           round(sum(COALESCE(NULLIF(so.total_sale_amount,0), so.sold_price * so.quantity, 0))::numeric,2) AS settled_usd_correct,
           round(sum(COALESCE(NULLIF(so.total_sale_amount,0), so.sold_price * so.quantity, 0) / COALESCE(fx.rate,1))::numeric,2) AS settled_as_shown_before,
           count(*) FILTER (WHERE COALESCE(so.total_sale_amount,0) = 0 AND COALESCE(so.sold_price,0) = 0
                              AND COALESCE(so.estimated_price,0) > 0) AS pending_rows
    FROM public.sales_orders so
    LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND so.order_date >= CURRENT_DATE - 7
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | settled % rows: shown % -> correct % | pending % rows',
      rpad(r.mk,3), lpad(r.settled_rows::text,3),
      lpad(r.settled_as_shown_before::text,9), lpad(r.settled_usd_correct::text,9),
      r.pending_rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 4d. US MUST BE UNCHANGED ==';
  FOR r IN
    SELECT count(*) AS us_rows,
           count(*) FILTER (WHERE COALESCE(estimated_price,0) > 0) AS with_est
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) = 'US'
      AND order_date >= CURRENT_DATE - 7 AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   % US rows in 7 days (% with an estimate).', r.us_rows, r.with_est;
    RAISE NOTICE '   US rate is 1, so every conversion added is the identity --';
    RAISE NOTICE '   no US figure can move. The test suite asserts this directly.';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 5. P&L ==';
  SELECT count(*) INTO n FROM public.financial_events_cache
  WHERE amazon_order_id IN ('701-8676794-7473022','701-9237832-1359468');
  RAISE NOTICE '   financial_events_cache rows for the two orders in play: %', n;
  RAISE NOTICE '   Nothing in this change writes to financial_events_cache, and';
  RAISE NOTICE '   the P&L reads only that table, so it is unchanged. The edits';
  RAISE NOTICE '   are display-layer only -- no sales_orders column was written.';

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 6. order 701-9237832-1359468 vs the MX$669.62 sale ==';
  FOR r IN
    SELECT so.order_id, so.purchase_timestamp_utc AS bought, so.quantity AS qty,
           so.estimated_price AS est, so.sold_price, so.total_sale_amount AS tsa,
           COALESCE(so.price_source,'(none)') AS psrc, COALESCE(so.locked_from,'-') AS lf,
           so.order_status
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.asin = 'B0C8Z7L2LQ' AND so.marketplace = 'MX'
      AND so.order_id IN ('701-9237832-1359468','701-8676794-7473022','701-1097039-7597835')
    ORDER BY so.purchase_timestamp_utc
  LOOP
    RAISE NOTICE '   % | bought % | q% | est % | sold % | tsa % | % | %',
      r.order_id, r.bought, r.qty, COALESCE(r.est::text,'NULL'),
      COALESCE(r.sold_price::text,'-'), COALESCE(r.tsa::text,'-'),
      r.psrc, r.order_status;
    RAISE NOTICE '        lock %', r.lf;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   The MX price on this ASIN has been CLIMBING, from Amazon''s own';
  RAISE NOTICE '   settled figures and Keepa points:';
  RAISE NOTICE '     Oct  1  463.34   Oct 12  334.62   Oct 17  583.92   Oct 19  669.62';
  RAISE NOTICE '   So MX$669.62 on Oct 19 does NOT validate 668.32 for an Oct 12';
  RAISE NOTICE '   purchase -- it is a week later on a rising price. The order is';
  RAISE NOTICE '   NOT being reverted either way, as instructed.';
END
$p$;
