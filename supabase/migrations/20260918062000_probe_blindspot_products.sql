-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- The skipped auto-lower assignments are real data gaps, not a worker read
-- bug. Do they matter -- is there anything to sell? For each skip group:
-- stock, fulfilment, last price push, and whether a created listing exists.

DO $p$
DECLARE v_uid uuid; r record; v jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT content::jsonb INTO v FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND created > now() - interval '30 minutes'
  ORDER BY created DESC LIMIT 1;

  CREATE TEMP TABLE _d AS
  SELECT d->>'assignment_id' AS assignment_id, d->>'reason' AS reason
  FROM jsonb_array_elements(v->'detail'->'decisions') d
  WHERE d->>'reason' IN ('no_inventory_row', 'no_competitor_data', 'exhausted_drop_count');

  FOR r IN
    SELECT _d.reason,
           count(*) AS n,
           count(*) FILTER (WHERE upper(COALESCE(to_jsonb(a)->>'fulfillment_type','')) = 'FBM') AS fbm,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.created_listings cl WHERE cl.user_id = a.user_id AND cl.sku = a.sku)) AS has_created_listing,
           count(*) FILTER (WHERE COALESCE(inv.qty, 0) > 0) AS in_stock,
           count(*) FILTER (WHERE (to_jsonb(a)->>'last_applied_at')::timestamptz > now() - interval '7 days'
                               OR (to_jsonb(a)->>'last_price_update_at')::timestamptz > now() - interval '7 days') AS priced_7d
    FROM _d
    JOIN public.repricer_assignments a ON a.id::text = _d.assignment_id
    LEFT JOIN LATERAL (
      SELECT sum(COALESCE(i.available,0) + COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) AS qty
      FROM public.inventory i WHERE i.user_id = a.user_id AND i.asin = a.asin
    ) inv ON true
    GROUP BY _d.reason ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '% : % | FBM % | has a created listing % | in stock (any SKU of the ASIN) % | price pushed in last 7 d %',
      r.reason, r.n, r.fbm, r.has_created_listing, r.in_stock, r.priced_7d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- drop-limited products that are in stock: current min vs lowest competitor --';
  FOR r IN
    SELECT a.asin, a.min_price_override AS min, a.auto_floor_drop_count AS drops, a.manual_min_price AS original,
           (SELECT s.lowest_fba_price FROM public.repricer_competitor_snapshots s WHERE s.asin = a.asin AND s.marketplace = 'US' ORDER BY s.fetched_at DESC LIMIT 1) AS lowest_fba,
           inv.qty
    FROM _d JOIN public.repricer_assignments a ON a.id::text = _d.assignment_id
    LEFT JOIN LATERAL (SELECT sum(COALESCE(i.available,0) + COALESCE(i.reserved,0) + COALESCE(i.inbound,0)) AS qty
                       FROM public.inventory i WHERE i.user_id = a.user_id AND i.asin = a.asin) inv ON true
    WHERE _d.reason = 'exhausted_drop_count' AND COALESCE(inv.qty, 0) > 0
    ORDER BY inv.qty DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % stock % | min % (started %) after % drops | lowest FBA %', r.asin, r.qty, r.min, r.original, r.drops, r.lowest_fba;
  END LOOP;

  DROP TABLE _d;
END
$p$;
