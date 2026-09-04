-- Prove a shared brand reaches a non-admin, that muting removes it, and that
-- the user's OWN row wins where both exist.
--
-- The last one matters most. user_brands carries each user's match_mode and
-- their 'ignore' status; if a catalogue row could override those, a brand a
-- user had deliberately stopped watching would come back through the shared
-- list with no way to tell why.

DO $$
DECLARE
  v_other uuid; v_id uuid; v_own_brand text;
  v_before bigint; v_after bigint; v_muted bigint; v_scope text; v_dupes bigint;
BEGIN
  SELECT u.id INTO v_other FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r
                     WHERE r.user_id = u.id AND r.role = 'admin')
    AND EXISTS (SELECT 1 FROM public.user_brands b WHERE b.user_id = u.id)
  ORDER BY u.created_at LIMIT 1;

  IF v_other IS NULL THEN
    RAISE NOTICE 'no non-admin account with brands -- skipping';
    RETURN;
  END IF;

  SELECT count(*) INTO v_before FROM public.get_effective_brands_for(v_other);

  INSERT INTO public.catalog_brands (brand, match_mode)
  VALUES ('__probe_brand__', 'exact') RETURNING id INTO v_id;

  SELECT count(*) INTO v_after FROM public.get_effective_brands_for(v_other);
  SELECT scope INTO v_scope FROM public.get_effective_brands_for(v_other)
   WHERE brand = '__probe_brand__';
  RAISE NOTICE 'non-admin effective brands: % -> %, arrived as scope=%',
    v_before, v_after, v_scope;

  INSERT INTO public.user_catalog_mutes (user_id, kind, target_id)
  VALUES (v_other, 'brand', v_id);
  SELECT count(*) INTO v_muted FROM public.get_effective_brands_for(v_other)
   WHERE brand = '__probe_brand__';
  RAISE NOTICE 'after mute, the matcher sees it: % (want 0)', v_muted;

  DELETE FROM public.user_catalog_mutes
   WHERE user_id = v_other AND kind = 'brand' AND target_id = v_id;
  DELETE FROM public.catalog_brands WHERE id = v_id;

  -- Overlap: a brand this user already carries must appear ONCE, as theirs.
  SELECT ub.brand INTO v_own_brand FROM public.user_brands ub
  WHERE ub.user_id = v_other AND COALESCE(ub.status,'') <> 'ignore'
    AND EXISTS (SELECT 1 FROM public.catalog_brands cb
                 WHERE lower(btrim(cb.brand)) = lower(btrim(ub.brand)))
  LIMIT 1;

  IF v_own_brand IS NOT NULL THEN
    SELECT count(*) INTO v_dupes FROM public.get_effective_brands_for(v_other)
     WHERE lower(btrim(brand)) = lower(btrim(v_own_brand));
    SELECT scope INTO v_scope FROM public.get_effective_brands_for(v_other)
     WHERE lower(btrim(brand)) = lower(btrim(v_own_brand)) LIMIT 1;
    RAISE NOTICE 'overlapping brand "%": appears % time(s), as scope=% (want 1 and user)',
      v_own_brand, v_dupes, v_scope;
  END IF;

  RAISE NOTICE 'catalogue holds % brands; this user ends at % effective',
    (SELECT count(*) FROM public.catalog_brands),
    (SELECT count(*) FROM public.get_effective_brands_for(v_other));
END $$;
