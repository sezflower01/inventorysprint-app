-- READ-ONLY. Items 4 and 5: list today's 30 adjustment events with whatever
-- detail the table actually holds, and establish whether a marketplace can be
-- derived instead of UNKNOWN.
--
-- Up front on item 4's scope: financial_events_cache carries event_type, asin,
-- marketplace and marketplace_id. It has NO sku column, NO quantity/units
-- column and NO free-text reason. So "reason, ASIN/SKU, units and amount"
-- cannot be fully served from this table -- units in particular are simply not
-- stored. event_type is the closest thing to a reason.
DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 4a. the 30 events, with what IS stored ==';
  FOR r IN
    SELECT amazon_order_id AS oid,
           COALESCE(event_type,'(none)') AS etype,
           COALESCE(asin,'(none)') AS asin,
           COALESCE(marketplace,'(none)') AS mk,
           COALESCE(marketplace_id,'(none)') AS mkid,
           round(COALESCE(warehouse_lost,0)::numeric,2) AS lost,
           round(COALESCE(warehouse_damage,0)::numeric,2) AS dmg
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = CURRENT_DATE
      AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0)
    ORDER BY (COALESCE(warehouse_lost,0) + COALESCE(warehouse_damage,0)) DESC
  LOOP
    RAISE NOTICE '   % | type % | asin % | mk %/% | lost % | dmg %',
      rpad(r.oid,22), rpad(r.etype,18), rpad(r.asin,12),
      rpad(r.mk,8), rpad(r.mkid,14), lpad(r.lost::text,8), r.dmg;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4b. is the ASIN populated at all on these rows? ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(*) FILTER (WHERE asin IS NOT NULL AND asin <> '' AND asin <> 'UNKNOWN') AS with_asin,
           count(DISTINCT event_type) AS types,
           string_agg(DISTINCT COALESCE(event_type,'(null)'), ', ') AS type_list
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = CURRENT_DATE
      AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0)
  LOOP
    RAISE NOTICE '   % rows | % carry an ASIN | % event_type value(s): %',
      r.rows, r.with_asin, r.types, r.type_list;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. CAN a marketplace be derived? ==';
  RAISE NOTICE '   Only if the ASIN is present AND that ASIN maps to exactly one';
  RAISE NOTICE '   marketplace in the seller''s own order history. An ASIN sold in';
  RAISE NOTICE '   two marketplaces cannot be attributed from the ASIN alone, and';
  RAISE NOTICE '   guessing would be worse than UNKNOWN.';
  FOR r IN
    WITH adj AS (
      SELECT DISTINCT asin FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_date = CURRENT_DATE
        AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0)
        AND asin IS NOT NULL AND asin <> '' AND asin <> 'UNKNOWN'
    )
    SELECT a.asin,
           count(DISTINCT so.marketplace) AS n_markets,
           string_agg(DISTINCT COALESCE(so.marketplace,'?'), ',') AS markets
    FROM adj a
    LEFT JOIN public.sales_orders so ON so.user_id = v_uid AND so.asin = a.asin
    GROUP BY a.asin ORDER BY a.asin LIMIT 30
  LOOP
    RAISE NOTICE '   % | % marketplace(s): %', rpad(r.asin,12), r.n_markets, r.markets;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO ASINs on these rows -- so marketplace CANNOT be derived.';
    RAISE NOTICE '   Item 5 is not achievable from the data as stored; it needs';
    RAISE NOTICE '   the ingest to carry Amazon''s own marketplace on the event.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4c. reimbursement vs COST, where an ASIN lets us compare ==';
  RAISE NOTICE '   A reimbursement materially BELOW cost is worth disputing.';
  FOR r IN
    WITH adj AS (
      SELECT asin, sum(COALESCE(warehouse_lost,0) + COALESCE(warehouse_damage,0)) AS credit
      FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_date = CURRENT_DATE
        AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0)
        AND asin IS NOT NULL AND asin <> '' AND asin <> 'UNKNOWN'
      GROUP BY asin
    )
    SELECT a.asin, round(a.credit::numeric,2) AS credit,
           round(max(COALESCE(inv.cost,0))::numeric,2) AS inv_cost
    FROM adj a
    LEFT JOIN public.inventory inv ON inv.user_id = v_uid AND inv.asin = a.asin
    GROUP BY a.asin, a.credit ORDER BY a.credit DESC LIMIT 20
  LOOP
    RAISE NOTICE '   % | credit % | inventory cost %',
      rpad(r.asin,12), lpad(r.credit::text,8), r.inv_cost;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no ASIN on these rows, so no cost comparison possible)'; END IF;
END
$p$;
