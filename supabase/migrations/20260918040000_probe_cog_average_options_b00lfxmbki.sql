-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller wants the COG page's "Price changed" card to also SUGGEST an average
-- (besides Use new / Keep). Two candidate formulas; measure both on the
-- reported example B00LFXMBKI (COG $12.10, new purchase $6.37 x 240 units).
--   A. stock-weighted:   (on-hand x COG + new units x new cost) / (on-hand + new units)
--   B. purchase-weighted: total spent / total units over the last 12 months of
--      purchase lots INCLUDING the new one (same lot rules as the COG import).

DO $p$
DECLARE v_uid uuid; r record; v_cog numeric; v_new numeric; v_new_units numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT unit_cost, price_change_unit_cost, price_change_units INTO v_cog, v_new, v_new_units
  FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B00LFXMBKI';
  RAISE NOTICE 'COG on record % | flagged new purchase % x % units', v_cog, v_new, v_new_units;

  RAISE NOTICE '';
  RAISE NOTICE '== purchase lots (created_listings), newest first ==';
  FOR r IN SELECT date_created, created_at::date AS created, sku, units, cost, amount,
                  CASE WHEN cost > 0 AND units > 0 THEN round(cost / units, 4) END AS unit,
                  validation_status
           FROM public.created_listings WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
           ORDER BY created_at DESC LIMIT 15 LOOP
    RAISE NOTICE '  % (%) sku=% units=% total=% amount=% unit=% %', r.date_created, r.created, r.sku, r.units, r.cost, r.amount, r.unit, r.validation_status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== on hand (inventory, all marketplaces, pooled) ==';
  FOR r IN SELECT sku, available, reserved, inbound, to_jsonb(i)->>'marketplace' AS mkt
           FROM public.inventory i WHERE user_id = v_uid AND asin = 'B00LFXMBKI' LOOP
    RAISE NOTICE '  sku=% mkt=% available=% reserved=% inbound=%', r.sku, r.mkt, r.available, r.reserved, r.inbound;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== candidate averages ==';
  FOR r IN
    WITH lots AS (
      SELECT cost, units, cost / units AS unit, created_at
      FROM public.created_listings
      WHERE user_id = v_uid AND asin = 'B00LFXMBKI' AND cost > 0 AND units > 0
        AND cost / units >= 0.10
        AND NOT (cost = amount AND units > 1)
        AND COALESCE(validation_status, '') NOT ILIKE '%fail%'
    ),
    stock AS (
      SELECT sum(COALESCE(available,0) + COALESCE(reserved,0)) AS on_hand,
             sum(COALESCE(inbound,0)) AS inbound
      FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
    )
    SELECT
      (SELECT on_hand FROM stock) AS on_hand, (SELECT inbound FROM stock) AS inbound,
      round(((SELECT on_hand FROM stock) * v_cog + v_new_units * v_new)
            / NULLIF((SELECT on_hand FROM stock) + v_new_units, 0), 2) AS a_stock_weighted,
      round((SELECT sum(cost) / sum(units) FROM lots WHERE created_at > now() - interval '365 days'), 2) AS b_12mo,
      (SELECT sum(units) FROM lots WHERE created_at > now() - interval '365 days') AS b_units,
      (SELECT count(*) FROM lots WHERE created_at > now() - interval '365 days') AS b_lots,
      round((SELECT sum(cost) / sum(units) FROM lots), 2) AS b_all_time
  LOOP
    RAISE NOTICE '  A stock-weighted: % (on hand % + inbound % not counted; new % units)', r.a_stock_weighted, r.on_hand, r.inbound, v_new_units;
    RAISE NOTICE '  B 12-month purchase-weighted (incl. new lot): % over % lots / % units', r.b_12mo, r.b_lots, r.b_units;
    RAISE NOTICE '  B all-time purchase-weighted: %', r.b_all_time;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many COGs are currently flagged "price changed" ==';
  FOR r IN SELECT count(*) AS n FROM public.asin_cog_on_record WHERE user_id = v_uid AND price_change_unit_cost IS NOT NULL LOOP
    RAISE NOTICE '  %', r.n;
  END LOOP;
END
$p$;
