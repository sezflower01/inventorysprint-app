-- Prove a shared category reaches a user who never added it, that muting
-- takes it back out, and that the WORKER agrees with the UI about both.
--
-- The worker is the half that matters. A shared category the panel shows but
-- check-seller-watchlist ignores is worse than no sharing at all: the filter
-- would claim to be doing something it is not.

DO $$
DECLARE
  v_user uuid; v_id uuid;
  v_ui_before int; v_ui_after int; v_ui_muted int;
  v_worker_before bigint; v_worker_after bigint; v_worker_muted bigint;
  v_scope text; v_flag boolean;
BEGIN
  SELECT user_id INTO v_user FROM public.user_brands LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  SELECT jsonb_array_length(public.get_effective_excluded_terms()) INTO v_ui_before;
  SELECT count(*) INTO v_worker_before
    FROM public.get_effective_excluded_terms_for(v_user);

  -- Admin adds a shared category, exactly as they would for themselves.
  INSERT INTO public.catalog_excluded_terms (kind, value, label)
  VALUES ('category', '__probe_category__', 'Probe Category')
  RETURNING id INTO v_id;

  SELECT jsonb_array_length(public.get_effective_excluded_terms()) INTO v_ui_after;
  SELECT count(*) INTO v_worker_after
    FROM public.get_effective_excluded_terms_for(v_user);

  SELECT e ->> 'scope', (e ->> 'muted')::boolean INTO v_scope, v_flag
  FROM jsonb_array_elements(public.get_effective_excluded_terms()) e
  WHERE e ->> 'value' = '__probe_category__';

  RAISE NOTICE 'UI: % -> % terms | worker: % -> % | arrived as scope=% muted=%',
    v_ui_before, v_ui_after, v_worker_before, v_worker_after, v_scope, v_flag;

  -- The user opts out of it.
  INSERT INTO public.user_catalog_mutes (user_id, kind, target_id)
  VALUES (v_user, 'excluded_term', v_id);

  SELECT count(*) INTO v_ui_muted
    FROM jsonb_array_elements(public.get_effective_excluded_terms()) e
   WHERE e ->> 'value' = '__probe_category__' AND (e ->> 'muted')::boolean;
  SELECT count(*) INTO v_worker_muted
    FROM public.get_effective_excluded_terms_for(v_user)
   WHERE value = '__probe_category__';

  RAISE NOTICE 'after mute -- UI still lists it flagged: % | worker applies it: % (want 1 and 0)',
    v_ui_muted, v_worker_muted;

  DELETE FROM public.user_catalog_mutes
   WHERE user_id = v_user AND kind = 'excluded_term' AND target_id = v_id;
  DELETE FROM public.catalog_excluded_terms WHERE id = v_id;

  SELECT count(*) INTO v_worker_muted
    FROM public.get_effective_excluded_terms_for(v_user)
   WHERE value = '__probe_category__';
  RAISE NOTICE 'after cleanup, worker sees it: % (want 0)', v_worker_muted;

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
