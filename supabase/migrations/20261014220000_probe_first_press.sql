-- READ-ONLY. First live press of the recheck button: did it do the right thing?
DO $p$
DECLARE v_uid uuid; r record; v_fx numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_fx FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;

  RAISE NOTICE '== 1. the audit trail (the backup written before the change) ==';
  FOR r IN
    SELECT order_id, asin, marketplace AS mk, old_estimate, new_estimate,
           COALESCE(old_price_source,'-') AS old_src,
           COALESCE(old_locked_from,'(none)') AS old_lock,
           keepa_track, keepa_point_at, applied_at
    FROM public.keepa_estimate_recheck_log
    WHERE user_id = v_uid ORDER BY applied_at DESC
  LOOP
    RAISE NOTICE '   % % %', r.order_id, r.asin, r.mk;
    RAISE NOTICE '     % -> %  (native CAD)', r.old_estimate, r.new_estimate;
    RAISE NOTICE '     was from % | lock % | keepa track % captured %',
      r.old_src, r.old_lock, r.keepa_track, r.keepa_point_at;
    RAISE NOTICE '     applied %', r.applied_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (empty - nothing recorded)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. the order now, and is it pinned against the next poll? ==';
  FOR r IN
    SELECT so.order_id, so.asin, so.quantity AS qty, so.sold_price,
           so.estimated_price, so.locked_est_price,
           COALESCE(so.locked_from,'(NOT LOCKED)') AS lf,
           COALESCE(so.price_source,'-') AS src,
           COALESCE(so.price_confidence,'-') AS conf, so.updated_at
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.order_id IN (SELECT order_id FROM public.keepa_estimate_recheck_log WHERE user_id = v_uid)
  LOOP
    RAISE NOTICE '   % % q%', r.order_id, r.asin, r.qty;
    RAISE NOTICE '     estimated_price CA$% | locked_est_price % | locked_from %',
      r.estimated_price, COALESCE(r.locked_est_price::text,'NULL'), r.lf;
    RAISE NOTICE '     price_source % | confidence %', r.src, r.conf;
    RAISE NOTICE '     sold_price % (0 = still pending, settlement will override)', r.sold_price;
    RAISE NOTICE '     = US$% at FX %', round((r.estimated_price/NULLIF(v_fx,0))::numeric,2), v_fx;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. accuracy against what Amazon actually charged ==';
  FOR r IN
    SELECT l.old_estimate, l.new_estimate
    FROM public.keepa_estimate_recheck_log l
    WHERE l.user_id = v_uid AND l.order_id = '701-1848920-5681843'
    ORDER BY l.applied_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '   Amazon charged CA$39.08/unit';
    RAISE NOTICE '   before  CA$%  -> % pct out', r.old_estimate,
      round((100*(r.old_estimate-39.08)/39.08)::numeric,1);
    RAISE NOTICE '   after   CA$%  -> % pct out', r.new_estimate,
      round((100*(r.new_estimate-39.08)/39.08)::numeric,1);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (that order was not the one updated)'; END IF;
END
$p$;
