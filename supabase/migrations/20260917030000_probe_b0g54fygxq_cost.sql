-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- B0G54FYGXQ: seller set COG 9.10 on the COG page; the Repricer and
-- Inventory Valuation still show 16.70. Which source in the chain
-- (override -> COG view -> created_listings -> inventory.cost) wins, and why?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== asin_cost_overrides ==';
  FOR r IN SELECT unit_cost, effective_from, created_at, to_jsonb(o) - 'user_id' AS j
           FROM public.asin_cost_overrides o WHERE user_id = v_uid AND asin = 'B0G54FYGXQ'
           ORDER BY effective_from DESC, created_at DESC LOOP
    RAISE NOTICE '  %', r.j;
  END LOOP;

  RAISE NOTICE '== asin_cog_on_record ==';
  FOR r IN SELECT to_jsonb(c) - 'user_id' - 'calculation' AS j
           FROM public.asin_cog_on_record c WHERE user_id = v_uid AND asin = 'B0G54FYGXQ' LOOP
    RAISE NOTICE '  %', r.j;
  END LOOP;

  RAISE NOTICE '== asin_cog_for_repricer (view) ==';
  FOR r IN SELECT unit_cost FROM public.asin_cog_for_repricer WHERE user_id = v_uid AND asin = 'B0G54FYGXQ' LOOP
    RAISE NOTICE '  unit_cost=%', r.unit_cost;
  END LOOP;

  RAISE NOTICE '== COG history (latest 5) ==';
  FOR r IN SELECT to_jsonb(h) - 'user_id' AS j FROM public.asin_cog_on_record_history h
           WHERE user_id = v_uid AND asin = 'B0G54FYGXQ' ORDER BY 1 DESC LIMIT 5 LOOP
    RAISE NOTICE '  %', left(r.j::text, 400);
  END LOOP;

  RAISE NOTICE '== inventory ==';
  FOR r IN SELECT sku, cost, unit_cost_manual, available, reserved, inbound FROM public.inventory
           WHERE user_id = v_uid AND asin = 'B0G54FYGXQ' LOOP
    RAISE NOTICE '  sku=% cost=% manual=% qty=%/%/%', r.sku, r.cost, r.unit_cost_manual, r.available, r.reserved, r.inbound;
  END LOOP;
END
$p$;
