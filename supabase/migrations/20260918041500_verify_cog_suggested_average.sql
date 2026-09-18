-- READ-ONLY VERIFICATION. Creates nothing, changes nothing.
-- Call get_cog_page_products() as the seller (it is SECURITY INVOKER and
-- scoped to auth.uid()) and confirm: the suggestion exists only on "Price
-- changed" rows, B00LFXMBKI reads $6.95 = $1,855.34 / 267 over 3 purchases,
-- and the row count is unchanged by the new columns.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  FOR r IN SELECT count(*) AS n_rows,
                  count(*) FILTER (WHERE price_change_unit_cost IS NOT NULL) AS flagged,
                  count(*) FILTER (WHERE suggested_avg_cost IS NOT NULL) AS with_suggestion,
                  count(*) FILTER (WHERE suggested_avg_cost IS NOT NULL AND price_change_unit_cost IS NULL) AS stray
           FROM public.get_cog_page_products() LOOP
    RAISE NOTICE 'rows % | flagged % | with suggestion % | suggestion on an unflagged row % (expect 0)', r.n_rows, r.flagged, r.with_suggestion, r.stray;
  END LOOP;

  FOR r IN SELECT asin, unit_cost, price_change_unit_cost, price_change_units,
                  suggested_avg_cost, suggested_avg_spent, suggested_avg_units, suggested_avg_lots, suggested_avg_window
           FROM public.get_cog_page_products() WHERE price_change_unit_cost IS NOT NULL LOOP
    RAISE NOTICE '  % COG % | new % x % | average % = % / % over % purchases (%)',
      r.asin, r.unit_cost, r.price_change_unit_cost, r.price_change_units,
      r.suggested_avg_cost, r.suggested_avg_spent, r.suggested_avg_units, r.suggested_avg_lots, r.suggested_avg_window;
  END LOOP;

  SET LOCAL ROLE postgres;
END
$p$;
