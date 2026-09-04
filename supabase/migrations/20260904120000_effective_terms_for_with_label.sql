-- Carry `label` on the server-side effective read too.
--
-- apply-title-exclusions writes the exclusion REASON onto listings and names
-- the term in it. `value` is the normalised form; `label` is what the user
-- actually typed, and is the readable half. Without it here that function
-- could not move onto the effective read without making its reasons worse.
--
-- Return type changes, so this DROPs first: CREATE OR REPLACE cannot alter a
-- function's return type (42P13).

DROP FUNCTION IF EXISTS public.get_effective_excluded_terms_for(uuid);

CREATE OR REPLACE FUNCTION public.get_effective_excluded_terms_for(p_user uuid)
RETURNS TABLE(kind text, value text, label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT e.kind, e.value, e.label
  FROM public.source_excluded_terms e
  WHERE e.user_id = p_user
  UNION
  -- Shared terms, minus the ones this user opted out of. A user who re-allowed
  -- a shared category must not have the worker keep filtering on it: the UI and
  -- the worker disagreeing about what is excluded is exactly what makes a
  -- filter untrustworthy.
  SELECT c.kind, c.value, c.label
  FROM public.catalog_excluded_terms c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_catalog_mutes m
     WHERE m.user_id = p_user AND m.kind = 'excluded_term' AND m.target_id = c.id
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_effective_excluded_terms_for(uuid) FROM public, anon, authenticated;
