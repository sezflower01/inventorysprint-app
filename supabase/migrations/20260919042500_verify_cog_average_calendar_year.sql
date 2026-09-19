-- READ-ONLY VERIFICATION. Creates nothing, changes nothing.
-- After the calendar-year window (20260919042000). As the seller: rows with an Average, how many would show the
-- button (average differs from the COG), that B00A6W0HEQ reads
-- $4.73 = $3,320.44 / 702 over 5 purchases (all dated 2026), that B00LFXMBKI
-- is unchanged, and how long the call takes.

DO $p$
DECLARE v_uid uuid; r record; t0 timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  t0 := clock_timestamp();
  FOR r IN SELECT count(*) AS n_rows,
                  count(*) FILTER (WHERE suggested_avg_cost IS NOT NULL) AS with_avg,
                  count(*) FILTER (WHERE suggested_avg_cost IS NOT NULL AND suggested_avg_cost <> COALESCE(unit_cost, -1)) AS shows_button,
                  count(*) FILTER (WHERE suggested_avg_cost IS NOT NULL AND unit_cost IS NOT NULL
                                     AND abs(suggested_avg_cost - unit_cost) >= 0.25) AS differs_25c
           FROM public.get_cog_page_products() LOOP
    RAISE NOTICE 'rows % | with average % | button shown % | average >= $0.25 from COG % | call took % ms',
      r.n_rows, r.with_avg, r.shows_button, r.differs_25c, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
  END LOOP;

  FOR r IN SELECT asin, unit_cost, price_change_unit_cost, suggested_avg_cost, suggested_avg_spent, suggested_avg_units, suggested_avg_lots, suggested_avg_window
           FROM public.get_cog_page_products() WHERE asin IN ('B00A6W0HEQ', 'B00LFXMBKI') LOOP
    RAISE NOTICE '  % COG % | price change % | average % = % / % over % purchases (%)', r.asin, r.unit_cost, r.price_change_unit_cost,
      r.suggested_avg_cost, r.suggested_avg_spent, r.suggested_avg_units, r.suggested_avg_lots, r.suggested_avg_window;
  END LOOP;

  FOR r IN SELECT suggested_avg_window AS w, count(*) AS n FROM public.get_cog_page_products()
           WHERE suggested_avg_cost IS NOT NULL GROUP BY 1 LOOP
    RAISE NOTICE '  window % : % rows (expect only year_to_date)', r.w, r.n;
  END LOOP;

  SET LOCAL ROLE postgres;
END
$p$;
