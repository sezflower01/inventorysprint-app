-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The US assignment for B09PJPB34P dispatched at 12:01 today, so
-- repricer-sp-api-pricing has already asked Amazon about our own offer and
-- stored what came back in detected_offer_* -- including detected_offer_sku,
-- which is the LIVE seller SKU as Amazon reports it. That answers "which SKU is
-- the recreated listing under" without spending another SP-API call, and
-- detected_offer_sku_match says whether it still agrees with what we store.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== detected offer, per marketplace ==';
  FOR r IN SELECT marketplace, sku, detected_offer_sku, detected_offer_sku_match AS sku_match,
                  detected_offer_price, detected_offer_fulfillment, detected_offer_condition,
                  detected_offer_mapping_source AS src, detected_offer_block_reason AS block,
                  detected_offer_checked_at AS checked,
                  last_buybox_price, last_buybox_status, last_applied_price, last_applied_at,
                  last_skip_reason, last_error_message, amazon_listing_state
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B09PJPB34P' ORDER BY marketplace LOOP
    RAISE NOTICE '  % | ours % | Amazon says % | match % | src % | block %',
      r.marketplace, r.sku, COALESCE(r.detected_offer_sku, '<none>'), r.sku_match, r.src, COALESCE(r.block, '');
    RAISE NOTICE '      offer price % % % | checked %',
      r.detected_offer_price, COALESCE(r.detected_offer_fulfillment, ''), COALESCE(r.detected_offer_condition, ''), r.checked;
    RAISE NOTICE '      buybox % (%) | applied % at % | listing_state %',
      r.last_buybox_price, r.last_buybox_status, r.last_applied_price, r.last_applied_at, r.amazon_listing_state;
    RAISE NOTICE '      skip % | error %', left(COALESCE(r.last_skip_reason, ''), 120), left(COALESCE(r.last_error_message, ''), 120);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every SKU this account has ever had on this ASIN, by table ==';
  FOR r IN
    SELECT 'inventory' AS src, sku, NULL::text AS extra FROM public.inventory WHERE user_id = v_uid AND asin = 'B09PJPB34P'
    UNION ALL
    SELECT 'assignment:' || marketplace, sku, NULL FROM public.repricer_assignments WHERE user_id = v_uid AND asin = 'B09PJPB34P'
    UNION ALL
    SELECT 'created_listings', sku, validation_status FROM public.created_listings WHERE user_id = v_uid AND asin = 'B09PJPB34P'
    UNION ALL
    SELECT 'sales_orders', COALESCE(sku, '<null>'), count(*)::text FROM public.sales_orders WHERE user_id = v_uid AND asin = 'B09PJPB34P' GROUP BY 1, 2
    ORDER BY 1, 2
  LOOP
    RAISE NOTICE '  % | % | %', r.src, r.sku, COALESCE(r.extra, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many OTHER listings are hidden the same way? ==';
  RAISE NOTICE '   (inventory NOT_IN_CATALOG / DELETED while an assignment is enabled)';
  FOR r IN SELECT i.listing_status, count(*) AS n, sum((a.is_enabled)::int) AS enabled,
                  sum(COALESCE(i.available, 0) + COALESCE(i.reserved, 0)) AS units
           FROM public.inventory i
           JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin AND a.marketplace = 'US'
           WHERE i.user_id = v_uid
             AND upper(COALESCE(i.listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED')
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % : % row(s), % enabled, % unit(s) of stock', r.listing_status, r.n, r.enabled, r.units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== of those, which look ALIVE again (stock, or priced today)? ==';
  FOR r IN SELECT i.asin, i.sku, i.listing_status, i.available, i.reserved,
                  a.is_enabled, a.last_applied_at, a.detected_offer_sku, i.ghost_reason
           FROM public.inventory i
           JOIN public.repricer_assignments a
             ON a.user_id = i.user_id AND a.asin = i.asin AND a.marketplace = 'US'
           WHERE i.user_id = v_uid
             AND upper(COALESCE(i.listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED')
             AND (COALESCE(i.available, 0) + COALESCE(i.reserved, 0) > 0
                  OR a.last_applied_at > now() - interval '7 days')
           ORDER BY i.available DESC NULLS LAST LIMIT 20 LOOP
    RAISE NOTICE '  % | % | % | avail % reserved % | enabled % | applied % | Amazon sku % | ghost %',
      r.asin, r.sku, r.listing_status, r.available, r.reserved, r.is_enabled, r.last_applied_at,
      COALESCE(r.detected_offer_sku, '<none>'), COALESCE(r.ghost_reason, '');
  END LOOP;
END
$p$;
