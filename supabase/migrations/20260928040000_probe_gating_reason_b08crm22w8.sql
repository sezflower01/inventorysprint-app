-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- "Restock gated" on B08CRM22W8 -- is it an approval the seller can apply for,
-- or a hard block? Amazon's reasonCode tells the two apart:
--   APPROVAL_REQUIRED -> a gate you can apply through (invoices etc.)
--   NOT_ELIGIBLE      -> Amazon has revoked eligibility; applying does nothing
-- Look for whatever reason text we have stored for this ASIN.

DO $p$
DECLARE v_uid uuid; r record; found boolean := false;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT asin, approval_status, score, to_char(checked_at, 'YYYY-MM-DD HH24:MI') AS checked
           FROM public.user_approved_products WHERE user_id = v_uid AND asin = 'B08CRM22W8' LOOP
    found := true;
    RAISE NOTICE 'user_approved_products: % | % | score % | checked %', r.asin, r.approval_status, r.score, r.checked;
  END LOOP;

  FOR r IN SELECT stage, status, to_char(checked_at, 'YYYY-MM-DD HH24:MI') AS checked,
                  left(COALESCE(reason, '-'), 220) AS reason
           FROM public.fba_readiness_cache
           WHERE user_id = v_uid AND asin = 'B08CRM22W8' ORDER BY checked_at DESC LIMIT 8 LOOP
    found := true;
    RAISE NOTICE 'readiness %: % (%) | %', r.stage, r.status, r.checked, r.reason;
  END LOOP;

  IF NOT found THEN RAISE NOTICE 'no stored reason text for this ASIN'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== have we ever sold it, and do we hold stock? ==';
  FOR r IN SELECT count(*) AS orders, sum(quantity) AS units, min(order_date) AS first_sale, max(order_date) AS last_sale
           FROM public.sales_orders WHERE user_id = v_uid AND asin = 'B08CRM22W8' AND COALESCE(is_cancelled,false) = false LOOP
    RAISE NOTICE '  sold: % orders, % units, % .. %', r.orders, r.units, r.first_sale, r.last_sale;
  END LOOP;
  FOR r IN SELECT sku, available, reserved, inbound, listing_status FROM public.inventory
           WHERE user_id = v_uid AND asin = 'B08CRM22W8' LOOP
    RAISE NOTICE '  stock: % | avail % res % inb % | %', r.sku, r.available, r.reserved, r.inbound, r.listing_status;
  END LOOP;
END
$p$;
