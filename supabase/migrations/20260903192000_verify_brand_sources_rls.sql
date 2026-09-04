-- Prove the new tables are readable AND writable by the signed-in user.
--
-- This check exists because the opposite was shipped hours earlier today:
-- seller_catalog_queue went out with RLS enabled and no policies, a SECURITY
-- INVOKER function read it as the user, and the browser silently got zero rows
-- while the service role saw 737. Creating the policies is not evidence they
-- work -- exercising them as the authenticated role is.
--
-- Ends with SET ROLE postgres rather than RESET ROLE. RESET ROLE restores the
-- bare login user, which cannot write supabase_migrations, so the migration
-- fails at commit and silently rolls back everything it just proved.

DO $$
DECLARE
  v_user uuid; v_brand text; v_rid uuid; v_map jsonb; v_entries int;
BEGIN
  SELECT user_id, brand INTO v_user, v_brand
  FROM public.user_brands
  WHERE COALESCE(status,'') <> 'ignore'
  ORDER BY asin_count DESC LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE 'no brands to test against -- skipping';
    RETURN;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  -- INSERT policy
  INSERT INTO public.user_retailers (user_id, label, url_template)
  VALUES (v_user, '__rls_probe__', 'https://example.com/search?q={title}')
  RETURNING id INTO v_rid;

  INSERT INTO public.user_brand_sources (user_id, brand, retailer_id, note)
  VALUES (v_user, v_brand, v_rid, 'probe note');

  -- SELECT policy, through the function the UI actually calls
  SELECT public.get_brand_sources() INTO v_map;
  v_entries := jsonb_array_length(COALESCE(v_map -> lower(btrim(v_brand)), '[]'::jsonb));

  RAISE NOTICE 'as AUTHENTICATED: brand %, entries returned = %, note = %',
    v_brand, v_entries,
    COALESCE(v_map -> lower(btrim(v_brand)) -> 0 ->> 'note', '(none)');
  RAISE NOTICE 'original spelling carried back = %',
    COALESCE(v_map -> lower(btrim(v_brand)) -> 0 ->> 'brand', '(missing)');

  -- DELETE policy. Cascades to the attachment.
  DELETE FROM public.user_retailers WHERE id = v_rid;

  SELECT public.get_brand_sources() INTO v_map;
  RAISE NOTICE 'after cleanup, entries = %',
    jsonb_array_length(COALESCE(v_map -> lower(btrim(v_brand)), '[]'::jsonb));

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;

SET ROLE postgres;
