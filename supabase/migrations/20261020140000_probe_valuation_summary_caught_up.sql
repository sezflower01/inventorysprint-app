-- READ-ONLY. inventory_valuation_summary is a cached TABLE on a 30-minute TTL
-- (src/lib/inventory-valuation.ts readInventoryValuationSummary: a row older
-- than maxAgeSeconds is treated as missing and the client falls back to a live
-- compute). So a stale row cannot show a wrong number for long -- but confirm
-- it has actually caught up, and that the live compute agrees.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the cached summary row ==';
  FOR r IN
    SELECT value, units, skus, available, reserved, inbound,
           computed_at,
           round(EXTRACT(EPOCH FROM (now() - computed_at))/60.0, 1) AS age_min,
           (EXTRACT(EPOCH FROM (now() - computed_at)) > 1800) AS stale_so_ignored
    FROM public.inventory_valuation_summary WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   value % | units % | skus %', r.value, r.units, r.skus;
    RAISE NOTICE '   available % | reserved % | inbound %', r.available, r.reserved, r.inbound;
    RAISE NOTICE '   computed_at % (% min ago) | past the 30-min TTL: %',
      r.computed_at, r.age_min, r.stale_so_ignored;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO cached row -- the client always computes live'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== live compute over non-ghost rows, for comparison ==';
  FOR r IN
    SELECT count(*) AS skus,
           sum(COALESCE(available,0)) AS available,
           sum(COALESCE(reserved,0)) AS reserved,
           sum(COALESCE(inbound,0)) AS inbound,
           round(sum(COALESCE(available,0) * COALESCE(cost,0)), 2) AS available_value
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND upper(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')
      AND lower(COALESCE(i.sku,'')) NOT LIKE 'amzn.gr.%'
      AND (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0)) > 0
  LOOP
    RAISE NOTICE '   skus % | available % | reserved % | inbound % | available_value %',
      r.skus, r.available, r.reserved, r.inbound, r.available_value;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and is B00LFXMBKI inside that non-ghost set now? ==';
  FOR r IN
    SELECT i.sku, i.listing_status, COALESCE(i.available,0) AS av,
           round(COALESCE(i.available,0) * COALESCE(i.cost,0), 2) AS val
    FROM public.inventory i
    WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
      AND upper(COALESCE(i.listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED','INACTIVE','INCOMPLETE','SUPPRESSED')
      AND lower(COALESCE(i.sku,'')) NOT LIKE 'amzn.gr.%'
      AND (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0)) > 0
  LOOP
    RAISE NOTICE '   YES: sku % | % | % units | contributes %', r.sku, r.listing_status, r.av, r.val;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO -- still excluded, something else is filtering it'; END IF;
END
$p$;
