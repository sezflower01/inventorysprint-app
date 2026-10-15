-- READ-ONLY. Mirror the button's target query exactly, so we know what a
-- press will touch before the seller presses it.
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== orders the button can act on (non-US, pending, estimate > 0) ==';
  FOR r IN
    SELECT so.marketplace AS mk, so.order_id, so.asin,
           so.estimated_price AS est_native,
           COALESCE(so.price_source,'-') AS src,
           so.order_date::date AS od,
           (SELECT (pt.elem->>'v')::numeric
            FROM public.keepa_price_history_cache k
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) AS pt(elem)
            WHERE k.asin = so.asin AND k.marketplace = so.marketplace
              AND (pt.elem->>'v')::numeric > 0
            ORDER BY (pt.elem->>'t') DESC LIMIT 1) AS keepa_bb_cached
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.is_cancelled,false) = false
      AND COALESCE(so.sold_price,0) = 0
      AND COALESCE(so.estimated_price,0) > 0
      AND so.order_id NOT LIKE '%-REFUND%'
    ORDER BY so.marketplace, so.order_date DESC
  LOOP
    RAISE NOTICE '  % | % | % | est % | src % | keepa cached %',
      rpad(r.mk,3), r.order_id, r.asin, lpad(r.est_native::text,8),
      rpad(r.src,24), COALESCE(r.keepa_bb_cached::text,'(none - will fetch)');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none right now - button will say "nothing to adjust")'; END IF;

  RAISE NOTICE '';
  SELECT count(*) INTO n FROM public.keepa_estimate_recheck_log;
  RAISE NOTICE '== audit table ready: % rows (0 expected, nothing pressed yet) ==', n;
END
$p$;
