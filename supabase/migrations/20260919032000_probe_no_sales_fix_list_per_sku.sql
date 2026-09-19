-- READ-ONLY PROBE. Creates nothing permanent, changes nothing.
-- 20260919031000 summed stock per ASIN, so an ASIN with 3 SKUs (main + two
-- amzn.gr Grade-and-Resell SKUs) showed its stock 3 times. Redo per SKU, and
-- show how fresh the "inactive" flag and the inventory row are.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _z AS
  SELECT a.asin, a.sku, a.status, a.is_enabled, a.is_listing_inactive_not_buyable AS inactive, a.is_pricing_suppression AS supp,
         a.listing_inactive_detected_at AS inact_since, a.listing_inactive_last_checked_at AS inact_checked,
         i.available, i.reserved, i.inbound, i.listing_status, i.last_inventory_sync_at AS inv_sync, i.fba_blocked, i.fba_block_reason,
         CASE WHEN NOT a.is_enabled OR a.status <> 'active' THEN 'OFF'
              WHEN a.is_pricing_suppression OR a.is_listing_inactive_not_buyable THEN 'HIDDEN' END AS grp
  FROM public.repricer_assignments a
  LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
  WHERE a.user_id = v_uid AND a.marketplace = 'US'
    AND a.asin IN (SELECT DISTINCT i2.asin FROM public.inventory i2 WHERE i2.user_id = v_uid AND COALESCE(i2.available,0) > 0)
    AND NOT EXISTS (SELECT 1 FROM public.sales_orders s
                    WHERE s.user_id = v_uid AND s.asin = a.asin AND COALESCE(s.is_cancelled,false) = false
                      AND s.order_date >= current_date - 30);

  RAISE NOTICE 'SKU|grp|asin|sku|avail|reserved|inbound|inv_listing_status|inv_sync|inactive_since|inactive_checked|fba_blocked';
  FOR r IN SELECT * FROM _z WHERE grp IS NOT NULL ORDER BY grp, asin, sku LOOP
    RAISE NOTICE 'SKU|%|%|%|%|%|%|%|%|%|%|%', r.grp, r.asin, r.sku, r.available, r.reserved, r.inbound, r.listing_status,
      to_char(r.inv_sync, 'MM-DD HH24:MI'), to_char(r.inact_since, 'YYYY-MM-DD'), to_char(r.inact_checked, 'MM-DD HH24:MI'),
      CASE WHEN r.fba_blocked THEN COALESCE(r.fba_block_reason, 'yes') ELSE '' END;
  END LOOP;

  RAISE NOTICE 'distinct ASINs: HIDDEN % | OFF % | both %',
    (SELECT count(DISTINCT asin) FROM _z WHERE grp = 'HIDDEN'), (SELECT count(DISTINCT asin) FROM _z WHERE grp = 'OFF'),
    (SELECT count(*) FROM (SELECT asin FROM _z WHERE grp IS NOT NULL GROUP BY asin HAVING count(DISTINCT grp) = 2) x);
  DROP TABLE _z;
END
$p$;
