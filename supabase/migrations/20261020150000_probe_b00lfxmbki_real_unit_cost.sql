-- READ-ONLY, and a correction to my own arithmetic. I reported B00LFXMBKI as
-- adding $5,075.00 to Inventory Valuation using inventory.cost (35.00) as the
-- unit cost. That is the LAST resort in the real chain, not the basis.
--
-- src/lib/inventory-valuation.ts resolves unit cost as:
--   COG on record (asin_cog_for_repricer) -> asin_cost_overrides ->
--   the Synced Inventory inline editor (unit_cost_manual + inventory.cost) ->
--   created_listings -> inventory.cost
--
-- Walk that chain for this one ASIN and read the figure the app will show.
DO $p$
DECLARE
  v_uid uuid; r record;
  v_cog numeric; v_override numeric; v_manual bool; v_invcost numeric;
  v_cl_cost numeric; v_cl_amount numeric; v_cl_units numeric;
  v_resolved numeric; v_basis text; v_avail int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT COALESCE(available,0), COALESCE(unit_cost_manual,false), cost
    INTO v_avail, v_manual, v_invcost
  FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI';

  SELECT unit_cost INTO v_cog
  FROM public.asin_cog_for_repricer
  WHERE user_id = v_uid AND asin = 'B00LFXMBKI' AND unit_cost IS NOT NULL
  LIMIT 1;

  SELECT unit_cost INTO v_override
  FROM public.asin_cost_overrides
  WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  ORDER BY effective_from DESC NULLS LAST LIMIT 1;

  SELECT cost, amount, units INTO v_cl_cost, v_cl_amount, v_cl_units
  FROM public.created_listings
  WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  ORDER BY created_at DESC LIMIT 1;

  RAISE NOTICE '== the chain, in order ==';
  RAISE NOTICE '   1 COG on record (asin_cog_for_repricer) : %', COALESCE(v_cog::text,'(none)');
  RAISE NOTICE '   2 asin_cost_overrides                   : %', COALESCE(v_override::text,'(none)');
  RAISE NOTICE '   3 inline editor (unit_cost_manual)      : % (inventory.cost %)',
    v_manual, COALESCE(v_invcost::text,'(null)');
  RAISE NOTICE '   4 created_listings cost/amount/units    : % / % / %',
    COALESCE(v_cl_cost::text,'-'), COALESCE(v_cl_amount::text,'-'), COALESCE(v_cl_units::text,'-');
  RAISE NOTICE '   5 inventory.cost                        : %', COALESCE(v_invcost::text,'(null)');

  IF v_cog IS NOT NULL THEN
    v_resolved := v_cog; v_basis := 'COG on record';
  ELSIF v_override IS NOT NULL THEN
    v_resolved := v_override; v_basis := 'asin_cost_overrides';
  ELSIF v_manual AND v_invcost IS NOT NULL THEN
    v_resolved := v_invcost; v_basis := 'inline editor';
  ELSIF v_cl_cost IS NOT NULL OR v_cl_amount IS NOT NULL THEN
    v_resolved := COALESCE(v_cl_cost, CASE WHEN COALESCE(v_cl_units,0) > 0
                                      THEN v_cl_amount / v_cl_units ELSE v_cl_amount END);
    v_basis := 'created_listings';
  ELSE
    v_resolved := COALESCE(v_invcost,0); v_basis := 'inventory.cost (last resort)';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== RESOLVED ==';
  RAISE NOTICE '   unit cost % from %', v_resolved, v_basis;
  RAISE NOTICE '   % available x % = %', v_avail, v_resolved, round(v_avail * v_resolved, 2);
  RAISE NOTICE '   (I previously said 5075.00 using inventory.cost 35.00)';
END
$p$;
