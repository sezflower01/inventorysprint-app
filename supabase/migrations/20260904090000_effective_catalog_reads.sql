-- Effective reads: shared UNION own MINUS muted.
--
-- Every one of these resolves at read time. Nothing is copied into a user's
-- account, so a retailer or exclusion added to the catalogue reaches every
-- tenant on their next load -- no sync job, no backfill, nothing to drift.
--
-- A user's own rows are never written back to the catalogue by any of these.
-- Private additions stay private, in both directions.

-- ---- RETAILERS ----------------------------------------------------------
--
-- Returns muted rows too, flagged, because the management UI has to show what
-- was opted out in order to offer opting back in. Callers that render buy
-- links filter on muted themselves -- get_brand_sources below does.
CREATE OR REPLACE FUNCTION public.get_effective_retailers()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_agg(r ORDER BY r ->> 'scope' DESC, lower(r ->> 'label')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'id', ur.id, 'label', ur.label, 'template', ur.url_template,
             'scope', 'user', 'muted', false
           ) AS r
    FROM public.user_retailers ur
    WHERE ur.user_id = auth.uid()
    UNION ALL
    SELECT jsonb_build_object(
             'id', cr.id, 'label', cr.label, 'template', cr.url_template,
             'scope', 'catalog',
             'muted', EXISTS (
               SELECT 1 FROM public.user_catalog_mutes m
                WHERE m.user_id = auth.uid() AND m.kind = 'retailer' AND m.target_id = cr.id
             )
           ) AS r
    FROM public.catalog_retailers cr
  ) t;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_effective_retailers() TO authenticated;

-- ---- BRAND -> SHOP ------------------------------------------------------
--
-- A brand mapping is always the USER'S OWN -- the catalogue never carries
-- brand-to-shop links. What changed is that the shop on the other end may be a
-- shared one, so the retailer is resolved from whichever table the scope names.
--
-- Muted shared shops drop out here: a user who opted out of a retailer should
-- not be sent there from a listing row.
CREATE OR REPLACE FUNCTION public.get_brand_sources()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_object_agg(k, entries), '{}'::jsonb)
  FROM (
    SELECT lower(btrim(s.brand)) AS k,
           jsonb_agg(
             jsonb_build_object(
               'retailer_id', COALESCE(ur.id, cr.id),
               'brand',       s.brand,
               'label',       COALESCE(ur.label, cr.label),
               'template',    COALESCE(ur.url_template, cr.url_template),
               'scope',       s.retailer_scope,
               'note',        s.note
             ) ORDER BY COALESCE(ur.label, cr.label)
           ) AS entries
    FROM public.user_brand_sources s
    LEFT JOIN public.user_retailers ur
      ON s.retailer_scope = 'user' AND ur.id = s.retailer_id AND ur.user_id = auth.uid()
    LEFT JOIN public.catalog_retailers cr
      ON s.retailer_scope = 'catalog' AND cr.id = s.retailer_id
    WHERE s.user_id = auth.uid()
      -- An orphaned mapping (its shop was deleted) resolves to neither side
      -- and is dropped rather than rendered as a nameless button.
      AND (ur.id IS NOT NULL OR cr.id IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM public.user_catalog_mutes m
         WHERE m.user_id = auth.uid() AND m.kind = 'retailer'
           AND m.target_id = s.retailer_id
      )
    GROUP BY lower(btrim(s.brand))
  ) t;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_brand_sources() TO authenticated;

-- ---- EXCLUDED TERMS -----------------------------------------------------
--
-- Categories and keywords not worth sourcing. Shared entries are generic
-- judgements ("DVDs are not worth sourcing") that every tenant benefits from,
-- and a user's own list adds to them rather than replacing it.
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
             'id', e.id, 'kind', e.kind, 'value', e.value,
             'scope', 'user', 'muted', false
           ) AS t
    FROM public.source_excluded_terms e
    WHERE e.user_id = auth.uid()
    UNION ALL
    SELECT jsonb_build_object(
             'id', c.id, 'kind', c.kind, 'value', c.value,
             'scope', 'catalog',
             'muted', EXISTS (
               SELECT 1 FROM public.user_catalog_mutes m
                WHERE m.user_id = auth.uid() AND m.kind = 'excluded_term'
                  AND m.target_id = c.id
             )
           ) AS t
    FROM public.catalog_excluded_terms c
    -- A shared term the user has also added themselves would otherwise appear
    -- twice, once mutable and once not.
    WHERE NOT EXISTS (
      SELECT 1 FROM public.source_excluded_terms e2
       WHERE e2.user_id = auth.uid() AND e2.kind = c.kind
         AND lower(btrim(e2.value)) = lower(btrim(c.value))
    )
  ) x;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_effective_excluded_terms() TO authenticated;

-- Prove the whole thing as a signed-in user rather than as the owner: the
-- catalogue is only useful if a NON-admin can read it, and RLS is where that
-- goes wrong. No SET ROLE -- it drops the CLI's elevated role and fails the
-- migration at commit.
DO $$
DECLARE v_user uuid; v_ret jsonb; v_shared int; v_own int;
BEGIN
  SELECT user_id INTO v_user FROM public.user_brands LIMIT 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  SELECT public.get_effective_retailers() INTO v_ret;
  SELECT count(*) INTO v_shared FROM jsonb_array_elements(v_ret) e
   WHERE e ->> 'scope' = 'catalog';
  SELECT count(*) INTO v_own FROM jsonb_array_elements(v_ret) e
   WHERE e ->> 'scope' = 'user';
  RAISE NOTICE 'effective retailers: % shared + % own', v_shared, v_own;

  RAISE NOTICE 'effective excluded terms: %',
    jsonb_array_length(public.get_effective_excluded_terms());
  RAISE NOTICE 'brand sources still resolve: % brands',
    (SELECT count(*) FROM jsonb_object_keys(public.get_brand_sources()));

  PERFORM set_config('request.jwt.claims', NULL, true);
END $$;
