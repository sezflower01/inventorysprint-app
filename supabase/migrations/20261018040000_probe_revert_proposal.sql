-- READ-ONLY. The revert proposal table, with the TRUE original value
-- (first press's old_estimate, ordered by applied_at -- not min(), which the
-- previous probe used and which understates any order pressed twice).
DO $p$
DECLARE v_uid uuid; r record; v_tot_now numeric := 0; v_tot_orig numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '=== REVERT PROPOSAL: per order, true original vs current ===';
  RAISE NOTICE '';
  FOR r IN
    WITH firsts AS (
      SELECT user_id, order_id, marketplace, asin,
             (array_agg(old_estimate ORDER BY applied_at))[1] AS orig,
             (array_agg(COALESCE(old_price_source,'-') ORDER BY applied_at))[1] AS orig_src,
             count(*) AS presses
      FROM public.keepa_estimate_recheck_log WHERE user_id = v_uid
      GROUP BY 1,2,3,4
    )
    SELECT f.marketplace AS mk, f.order_id, f.asin, so.quantity AS qty, f.presses,
           f.orig, so.estimated_price AS now_est, f.orig_src,
           fx.rate AS fx,
           round((f.orig * so.quantity / fx.rate)::numeric,2) AS usd_orig,
           round((so.estimated_price * so.quantity / fx.rate)::numeric,2) AS usd_now,
           round((100*(so.estimated_price - f.orig)/NULLIF(f.orig,0))::numeric,1) AS pct
    FROM firsts f
    JOIN public.sales_orders so ON so.order_id = f.order_id AND so.user_id = f.user_id
    JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE f.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE COALESCE(so.sold_price,0) = 0
    ORDER BY abs(so.estimated_price - f.orig) * so.quantity / fx.rate DESC
  LOOP
    RAISE NOTICE '   % % % q% (% press%)', rpad(r.mk,3), r.order_id, r.asin, r.qty,
      r.presses, CASE WHEN r.presses = 1 THEN '' ELSE 'es' END;
    RAISE NOTICE '        native  % -> %  (% pct) | was from %',
      lpad(r.orig::text,8), lpad(r.now_est::text,8), r.pct, r.orig_src;
    RAISE NOTICE '        USD    $% -> $%   (revert moves US$%)',
      lpad(r.usd_orig::text,7), lpad(r.usd_now::text,7),
      round((r.usd_orig - r.usd_now)::numeric,2);
    v_tot_now := v_tot_now + r.usd_now;
    v_tot_orig := v_tot_orig + r.usd_orig;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   TOTAL across all 8 unsettled rows:';
  RAISE NOTICE '     reported now  US$%', round(v_tot_now,2);
  RAISE NOTICE '     after revert  US$%', round(v_tot_orig,2);
  RAISE NOTICE '     change        US$%', round(v_tot_orig - v_tot_now,2);
END
$p$;
