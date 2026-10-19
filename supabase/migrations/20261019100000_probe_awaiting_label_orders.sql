-- READ-ONLY. My window theory was WRONG. Every order tagged MFN already has a
-- label fee from amazon_finances (October 10/10, 100 pct coverage all year, 0
-- entered by hand), and job 172 succeeded 48 times in 24h.
--
-- But 6 of the 7 order ids on the seller's screen do not appear in that MFN
-- list at all. Look them up directly: if their fulfillment_channel is not MFN,
-- the poller never considers them, while the UI's "awaiting label fee" list
-- uses a broader test and shows them anyway.
DO $p$
DECLARE v_uid uuid; r record; v_ids text[] := ARRAY[
  '112-7360199-5292260','111-9775100-7119447','112-1158126-2871457',
  '113-3678765-0171412','112-2714708-8150669','111-5481970-0090636',
  '112-5310326-3705811'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the 7 orders shown as "awaiting label fee" ==';
  FOR r IN
    SELECT so.order_id, so.order_date, so.quantity AS qty,
           COALESCE(so.fulfillment_channel,'(NULL)') AS fc,
           COALESCE(so.shipping_label_fee::text,'NULL') AS fee,
           COALESCE(so.shipping_label_fee_source,'(none)') AS src,
           COALESCE(so.shipping_label_fee_poll_attempts::text,'-') AS att,
           COALESCE(so.shipping_label_fee_last_polled_at::text,'never') AS last_poll,
           COALESCE(so.sold_price,0) AS sold, so.order_status
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.order_id = ANY(v_ids)
    ORDER BY so.order_date DESC
  LOOP
    RAISE NOTICE '   % | % | q% | channel % <<<', r.order_id, r.order_date, r.qty, r.fc;
    RAISE NOTICE '        fee % from % | attempts % | last polled %',
      lpad(r.fee,7), rpad(r.src,16), r.att, r.last_poll;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== THE DECIDING QUESTION: what channel are they tagged? ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(shipping_label_fee,0) > 0) AS with_fee
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = ANY(v_ids)
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   channel % | % orders | % have a fee', rpad(r.fc,10), r.orders, r.with_fee;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how does the POLLER pick candidates? (its channel filter) ==';
  RAISE NOTICE '   If it requires MFN and these are AFN or NULL, they are';
  RAISE NOTICE '   invisible to it no matter how wide the window gets --';
  RAISE NOTICE '   which is why widening WINDOW_DAYS would have fixed nothing.';

  RAISE NOTICE '';
  RAISE NOTICE '== scale: orders with NO channel tag at all, this year ==';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon, count(*) AS orders,
           count(*) FILTER (WHERE fulfillment_channel IS NULL
                              OR fulfillment_channel = ''
                              OR upper(fulfillment_channel) = 'UNKNOWN') AS no_channel
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 120
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1 DESC
  LOOP
    RAISE NOTICE '   % | % orders | % with NO channel tag', r.mon, lpad(r.orders::text,5), r.no_channel;
  END LOOP;
END
$p$;
