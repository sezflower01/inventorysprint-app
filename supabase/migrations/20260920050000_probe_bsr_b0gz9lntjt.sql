-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- BSR/Est still blank for B0GZ9LNTJT after the Amazon-rank fallback shipped.
-- Two possible explanations: the panel is still 1.4.5 (fallback not loaded),
-- or neither Keepa nor Amazon publishes a rank for this ASIN. Check what we
-- hold for it.

DO $p$
DECLARE v_uid uuid; r record; found boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT marketplace, verdict, series_used, drops_90, to_char(fetched_at, 'MM-DD HH24:MI') AS fetched,
                  to_char(expires_at, 'MM-DD HH24:MI') AS expires,
                  raw->'intel'->>'bsr_current' AS keepa_bsr,
                  raw->'intel'->>'bsr_avg_90' AS keepa_bsr_avg,
                  raw->'intel'->>'est_monthly_sales' AS est,
                  raw->'intel'->>'monthly_sold' AS monthly_sold,
                  raw->'intel'->>'product_age_days' AS age_days,
                  raw->'intel'->>'title' AS title
           FROM public.keepa_price_stability_cache WHERE asin = 'B0GZ9LNTJT' LOOP
    found := true;
    RAISE NOTICE 'stability cache %: verdict % series % drops90 % | Keepa BSR % (avg90 %) | est % | monthly_sold % | age % days | fetched % expires %',
      r.marketplace, r.verdict, r.series_used, r.drops_90, COALESCE(r.keepa_bsr,'(none)'), COALESCE(r.keepa_bsr_avg,'(none)'),
      COALESCE(r.est,'(none)'), COALESCE(r.monthly_sold,'(none)'), COALESCE(r.age_days,'?'), r.fetched, r.expires;
    RAISE NOTICE '  title: %', COALESCE(r.title, '(none)');
  END LOOP;
  IF NOT found THEN RAISE NOTICE 'no stability cache row for B0GZ9LNTJT (never scanned, or cache expired and was deleted)'; END IF;

  FOR r IN SELECT asin, brand, title, product_group, source, to_char(checked_at, 'MM-DD HH24:MI') AS checked
           FROM public.asin_brand_cache WHERE asin = 'B0GZ9LNTJT' LOOP
    RAISE NOTICE 'brand cache: brand % | group % | source % | checked % | title %', COALESCE(r.brand,'-'), COALESCE(r.product_group,'-'), r.source, r.checked, left(COALESCE(r.title,'-'), 50);
  END LOOP;

  FOR r IN SELECT sku, bsr, to_char(last_bsr_sync_at, 'MM-DD HH24:MI') AS bsr_sync, listing_status, left(title, 50) AS title
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B0GZ9LNTJT' LOOP
    RAISE NOTICE 'inventory: sku % | bsr % (synced %) | % | %', r.sku, COALESCE(r.bsr::text,'(none)'), COALESCE(r.bsr_sync,'-'), r.listing_status, r.title;
  END LOOP;

  -- Does ANY of our data hold a rank for this ASIN?
  FOR r IN SELECT count(*) AS seller_rows, count(*) FILTER (WHERE sales_rank IS NOT NULL) AS with_rank
           FROM public.seller_watch_new_listings WHERE asin = 'B0GZ9LNTJT' LOOP
    RAISE NOTICE 'seller-watch rows for this ASIN: % (% with a stored rank)', r.seller_rows, r.with_rank;
  END LOOP;
END
$p$;
