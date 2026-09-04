-- Give shared exclusions the same shape as a user's own, so one list can hold
-- both.
--
-- source_excluded_terms carries `label` -- the friendly name a toggle shows
-- ("Movies & TV") as against the raw websiteDisplayGroupName values it covers.
-- Without it here, a shared category would render as its API value while the
-- user's own rendered as English, in the same list.

ALTER TABLE public.catalog_excluded_terms
  ADD COLUMN IF NOT EXISTS label text;

CREATE OR REPLACE FUNCTION public.get_effective_excluded_terms()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_agg(t ORDER BY t ->> 'kind', lower(t ->> 'value')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'id', e.id, 'kind', e.kind, 'value', e.value, 'label', e.label,
             'scope', 'user', 'muted', false
           ) AS t
    FROM public.source_excluded_terms e
    WHERE e.user_id = auth.uid()
    UNION ALL
    SELECT jsonb_build_object(
             'id', c.id, 'kind', c.kind, 'value', c.value, 'label', c.label,
             'scope', 'catalog',
             'muted', EXISTS (
               SELECT 1 FROM public.user_catalog_mutes m
                WHERE m.user_id = auth.uid() AND m.kind = 'excluded_term'
                  AND m.target_id = c.id
             )
           ) AS t
    FROM public.catalog_excluded_terms c
    -- A term the user also added themselves would otherwise appear twice: once
    -- deletable, once only mutable. Their own row wins, since it is the one
    -- they can actually act on.
    WHERE NOT EXISTS (
      SELECT 1 FROM public.source_excluded_terms e2
       WHERE e2.user_id = auth.uid() AND e2.kind = c.kind
         AND lower(btrim(e2.value)) = lower(btrim(c.value))
    )
  ) x;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_effective_excluded_terms() TO authenticated;

-- ---- THE SERVER-SIDE READ ----------------------------------------------
--
-- check-seller-watchlist runs as the service role on behalf of a user, so it
-- cannot use auth.uid(). It gets an explicit-user variant rather than being
-- handed the auth.uid() one with a fake JWT: the caller is genuinely a
-- background job acting for someone, and saying so in the signature is
-- clearer than pretending to be them.
--
-- Muted terms are excluded here too. A user who re-allowed a shared category
-- must not have the worker keep filtering on it -- the UI and the worker
-- disagreeing about what is excluded is precisely the class of bug that makes
-- a filter untrustworthy.
CREATE OR REPLACE FUNCTION public.get_effective_excluded_terms_for(p_user uuid)
RETURNS TABLE(kind text, value text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT e.kind, e.value
  FROM public.source_excluded_terms e
  WHERE e.user_id = p_user
  UNION
  SELECT c.kind, c.value
  FROM public.catalog_excluded_terms c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_catalog_mutes m
     WHERE m.user_id = p_user AND m.kind = 'excluded_term' AND m.target_id = c.id
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_effective_excluded_terms_for(uuid) FROM public, anon, authenticated;

DO $$
DECLARE v_user uuid; v_own bigint; v_eff bigint;
BEGIN
  SELECT user_id INTO v_user FROM public.source_excluded_terms LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'no exclusions to test against';
    RETURN;
  END IF;
  SELECT count(*) INTO v_own FROM public.source_excluded_terms WHERE user_id = v_user;
  SELECT count(*) INTO v_eff FROM public.get_effective_excluded_terms_for(v_user);
  RAISE NOTICE 'user % : own=% effective=% (shared catalogue currently holds %)',
    v_user, v_own, v_eff, (SELECT count(*) FROM public.catalog_excluded_terms);
END $$;
