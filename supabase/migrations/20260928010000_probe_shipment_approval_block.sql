-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Amazon refused inbound plan wfdaaf7e62-3dd8-4917-9008-44b3dfcbdd13:
-- "Approval is required before this item can be sent to Amazon" -- without
-- naming the item. One gated SKU fails the whole plan (setPrepDetails had
-- already accepted 37 MSKUs), so the shipment cannot go until it is found.
--
-- The plan's items are posted from the browser and are not stored for a failed
-- attempt, so instead: which ASINs that currently hold stock are NOT approved
-- for this account? Those are the candidates to pull out of the shipment.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT approval_status, count(*) AS asins
           FROM public.user_approved_products
           WHERE user_id = v_uid AND COALESCE(marketplace, 'US') = 'US'
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE 'eligibility on record: % -> % ASINs', COALESCE(r.approval_status, '(null)'), r.asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== NOT approved, and you hold stock: the ones that can block a shipment ==';
  FOR r IN
    SELECT uap.asin, uap.approval_status, to_char(uap.checked_at, 'YYYY-MM-DD') AS checked,
           sum(COALESCE(i.available,0) + COALESCE(i.reserved,0)) AS stock,
           string_agg(DISTINCT i.sku, ', ') AS skus,
           left(max(i.title), 45) AS title
    FROM public.user_approved_products uap
    JOIN public.inventory i ON i.user_id = uap.user_id AND i.asin = uap.asin
    WHERE uap.user_id = v_uid
      AND COALESCE(uap.marketplace, 'US') = 'US'
      AND uap.approval_status IS DISTINCT FROM 'approved'
    GROUP BY 1, 2, 3
    HAVING sum(COALESCE(i.available,0) + COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) > 0
    ORDER BY 4 DESC LIMIT 20
  LOOP
    RAISE NOTICE '  % | % (checked %) | stock % | % | %', r.asin, r.approval_status, r.checked, r.stock, r.skus, r.title;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the ones never checked at all ==';
  FOR r IN
    SELECT count(DISTINCT i.asin) AS asins
    FROM public.inventory i
    WHERE i.user_id = v_uid
      AND (COALESCE(i.available,0) + COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) > 0
      AND NOT EXISTS (SELECT 1 FROM public.user_approved_products u
                      WHERE u.user_id = v_uid AND u.asin = i.asin)
  LOOP
    RAISE NOTICE '  % stocked ASINs have no eligibility record at all', r.asins;
  END LOOP;
END
$p$;
