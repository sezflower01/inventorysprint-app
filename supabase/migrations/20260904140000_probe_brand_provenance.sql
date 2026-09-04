-- Read-only: where did the brand list actually come from?
DO $$
DECLARE r RECORD; v_inv bigint; v_man bigint; v_users bigint;
BEGIN
  SELECT count(*) FILTER (WHERE source = 'inventory'),
         count(*) FILTER (WHERE source = 'manual'),
         count(DISTINCT user_id)
    INTO v_inv, v_man, v_users FROM public.user_brands;
  RAISE NOTICE 'user_brands: % from inventory, % added by hand, across % accounts',
    v_inv, v_man, v_users;

  FOR r IN
    SELECT ub.user_id,
           count(*) AS brands,
           count(*) FILTER (WHERE ub.source = 'manual') AS manual,
           (SELECT count(DISTINCT i.brand) FROM public.inventory i
             WHERE i.user_id = ub.user_id AND i.brand IS NOT NULL
               AND btrim(i.brand) <> '') AS derivable_now
    FROM public.user_brands ub GROUP BY ub.user_id ORDER BY count(*) DESC LIMIT 5
  LOOP
    RAISE NOTICE '  account %: % brands (% manual), % derivable from their own inventory',
      r.user_id, r.brands, r.manual, r.derivable_now;
  END LOOP;
END $$;
