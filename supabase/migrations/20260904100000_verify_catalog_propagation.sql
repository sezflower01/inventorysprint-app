-- Prove the shared catalogue is a LIVING resource, not a signup snapshot.
--
-- The claim under test: a retailer added after users already exist appears for
-- them with no sync, no job and no re-registration. Asserting that in prose is
-- cheap; the read-time union either does it or it does not.
--
-- Adds a probe retailer, reads it back as a NON-ADMIN user who was created long
-- before it existed, then removes it.

DO $$
DECLARE
  v_admin uuid; v_other uuid; v_rid uuid;
  v_before int; v_after int; v_found boolean; v_is_admin boolean;
BEGIN
  SELECT ur.user_id INTO v_admin
  FROM public.user_roles ur WHERE ur.role = 'admin' LIMIT 1;

  -- Any user who is NOT that admin: the point is propagation to someone else.
  SELECT u.id INTO v_other FROM auth.users u
  WHERE u.id IS DISTINCT FROM v_admin
    AND NOT EXISTS (SELECT 1 FROM public.user_roles r
                     WHERE r.user_id = u.id AND r.role = 'admin')
  ORDER BY u.created_at LIMIT 1;

  IF v_other IS NULL THEN
    RAISE NOTICE 'only one account exists -- propagation untestable, skipping';
    RETURN;
  END IF;

  SELECT public.has_role(v_other, 'admin') INTO v_is_admin;
  RAISE NOTICE 'test user % is admin: % (policy blocks their catalogue writes)',
    v_other, v_is_admin;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
  SELECT jsonb_array_length(public.get_effective_retailers()) INTO v_before;

  -- The admin finds a new shop while sourcing, exactly as they would normally.
  INSERT INTO public.catalog_retailers (label, url_template)
  VALUES ('__propagation_probe__', 'https://example-probe.com/search?q={title}')
  RETURNING id INTO v_rid;

  -- Same user, same session, no refresh, no re-login.
  SELECT jsonb_array_length(public.get_effective_retailers()) INTO v_after;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.get_effective_retailers()) e
     WHERE e ->> 'label' = '__propagation_probe__'
  ) INTO v_found;

  RAISE NOTICE 'existing user saw % shops before, % after. New shop visible: %',
    v_before, v_after, v_found;

  DELETE FROM public.catalog_retailers WHERE id = v_rid;

  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.get_effective_retailers()) e
     WHERE e ->> 'label' = '__propagation_probe__'
  ) INTO v_found;
  RAISE NOTICE 'after removal, still visible: % (should be false)', v_found;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
