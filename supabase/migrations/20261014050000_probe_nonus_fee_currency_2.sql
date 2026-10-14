-- READ-ONLY. The non-US fee cache is 18.9 pct out on CA, 67.9 on MX and
-- 75.6 on BR against what Amazon actually billed, while US is 2.0. Before
-- anyone computes fees from it for CA/BR/MX, find out whether that is a
-- currency problem -- the same one that made estimated_price look 1,630 pct
-- wrong on MX -- or genuinely bad fee data.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== cached FBA fee vs billed, per ASIN -- what is the RATIO? ==';
  RAISE NOTICE '   a ratio near the FX rate means a unit mismatch, not bad data';
  FOR r IN
    WITH billed AS (
      SELECT asin, marketplace, sum(fba_fee)/NULLIF(sum(quantity),0) AS actual
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(is_cancelled,false)=false
        AND order_id NOT LIKE '%-REFUND%' AND COALESCE(fba_fee,0) > 0
        AND upper(COALESCE(fulfillment_channel,'')) LIKE 'AFN%'
      GROUP BY 1,2
    )
    SELECT b.marketplace AS mk, count(*) AS asins,
           round(avg(fc.fba_fee_fixed / NULLIF(b.actual,0))::numeric,2) AS avg_ratio,
           round((percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY fc.fba_fee_fixed / NULLIF(b.actual,0)))::numeric,2) AS median_ratio,
           round(max(fx.rate)::numeric,2) AS usd_to_native
    FROM billed b
    JOIN public.asin_fee_cache fc
      ON fc.user_id = v_uid AND fc.asin = b.asin AND fc.marketplace = b.marketplace
     AND fc.fba_fee_fixed > 0
    LEFT JOIN public.fx_rates fx ON fx.base='USD'
      AND fx.quote = CASE upper(b.marketplace) WHEN 'CA' THEN 'CAD'
            WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' ELSE 'USD' END
    GROUP BY 1 ORDER BY asins DESC
  LOOP
    RAISE NOTICE '  % | % ASINs | cached/billed avg % median % | USD->native %',
      rpad(r.mk,4), lpad(r.asins::text,6), lpad(r.avg_ratio::text,7),
      lpad(r.median_ratio::text,7), r.usd_to_native;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== fee_source on non-US rows: who wrote them? ==';
  FOR r IN
    SELECT marketplace, COALESCE(fee_source,'(null)') AS src, count(*) AS rows,
           round(avg(fba_fee_fixed)::numeric,2) AS avg_fba,
           round(avg(referral_rate*100)::numeric,2) AS avg_ref_pct
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND marketplace <> 'US' AND fba_fee_fixed > 0
    GROUP BY 1,2 ORDER BY 1, rows DESC
  LOOP
    RAISE NOTICE '  % | % | % rows | fba $% | referral % pct',
      rpad(r.marketplace,4), rpad(r.src,24), lpad(r.rows::text,5), lpad(r.avg_fba::text,8), r.avg_ref_pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how much non-US stock is there, to size the question ==';
  FOR r IN
    SELECT count(DISTINCT asin) AS asins, count(*) AS rows,
           sum(COALESCE(available,0) + COALESCE(reserved,0)) AS units
    FROM public.inventory WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  inventory pool: % ASINs | % rows | % units (one pool, all four marketplaces)',
      r.asins, r.rows, r.units;
  END LOOP;
END
$p$;
