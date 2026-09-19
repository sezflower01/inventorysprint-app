-- READ-ONLY PROBE. Creates nothing permanent, changes nothing.
-- The VA fix list from 20260919030000: in-stock US listings with 0 sales in
-- 30 days that are (a) suppressed/inactive on Amazon or (b) have the repricer
-- off / needing attention. One pipe-delimited line per listing, with the
-- reason Amazon or the repricer recorded.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _a AS
  SELECT a.*, ru.name AS rule_name, inv.qty, inv.my_price, inv.title, inv.inv_sku
  FROM public.repricer_assignments a
  LEFT JOIN public.repricer_rules ru ON ru.id = a.rule_id
  JOIN LATERAL (
    SELECT sum(COALESCE(i.available,0)) AS qty, max(COALESCE(i.my_price, i.price)) AS my_price,
           max(i.title) AS title, max(i.sku) AS inv_sku
    FROM public.inventory i WHERE i.user_id = a.user_id AND i.asin = a.asin
  ) inv ON inv.qty > 0
  WHERE a.user_id = v_uid AND a.marketplace = 'US'
    AND NOT EXISTS (SELECT 1 FROM public.sales_orders s
                    WHERE s.user_id = v_uid AND s.asin = a.asin AND COALESCE(s.is_cancelled,false) = false
                      AND s.order_date >= current_date - 30);

  CREATE TEMP TABLE _z AS
  SELECT a.*, sn.lowest_overall_price AS lowest,
         (SELECT max(order_date) FROM public.sales_orders s WHERE s.user_id = v_uid AND s.asin = a.asin AND COALESCE(s.is_cancelled,false) = false) AS last_sale,
         CASE WHEN NOT a.is_enabled OR a.status <> 'active' THEN 'OFF' WHEN a.is_pricing_suppression OR a.is_listing_inactive_not_buyable THEN 'HIDDEN' END AS grp
  FROM _a a
  LEFT JOIN public.latest_competitor_snapshots(v_uid, (SELECT array_agg(DISTINCT asin) FROM _a), 'US') sn ON sn.asin = a.asin;

  RAISE NOTICE 'ROW|grp|asin|sku|qty|price|lowest|min|rule|status|enabled|last_sale|reason|title';
  FOR r IN SELECT * FROM _z WHERE grp IS NOT NULL ORDER BY grp, qty DESC, asin LOOP
    RAISE NOTICE 'ROW|%|%|%|%|%|%|%|%|%|%|%|%|%', r.grp, r.asin, COALESCE(r.sku, r.inv_sku), r.qty, r.my_price, round(r.lowest, 2), r.min_price_override,
      COALESCE(r.rule_name, '(no rule)'), r.status, r.is_enabled, COALESCE(r.last_sale::text, 'never'),
      replace(left(CASE WHEN r.grp = 'HIDDEN' THEN concat_ws(' / ',
                  CASE WHEN r.is_pricing_suppression THEN 'Pricing suppression: ' || COALESCE(r.pricing_suppression_raw_message, r.pricing_suppression_raw_code, array_to_string(r.pricing_suppression_categories, ', ')) END,
                  CASE WHEN r.is_listing_inactive_not_buyable THEN 'Inactive: ' || COALESCE(array_to_string(r.listing_inactive_statuses, ', '), '?') END)
                ELSE concat_ws(' / ', r.last_disabled_reason, r.paused_reason, r.pause_reason, r.last_error_message,
                               CASE WHEN r.last_disabled_by IS NOT NULL THEN 'by ' || r.last_disabled_by END,
                               CASE WHEN r.last_disabled_at IS NOT NULL THEN 'on ' || to_char(r.last_disabled_at, 'YYYY-MM-DD') END) END, 220), '|', '/'),
      replace(left(r.title, 70), '|', '/');
  END LOOP;

  DROP TABLE _z; DROP TABLE _a;
END
$p$;
