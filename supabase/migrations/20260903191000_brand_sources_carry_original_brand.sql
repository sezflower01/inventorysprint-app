-- Carry the ORIGINAL brand spelling in each source entry.
--
-- The map is keyed by lower(btrim(brand)) because that is what a listing's
-- brand has to be matched against -- Amazon's string never matches what the
-- user typed byte for byte. But the ROW is stored under the user's own
-- spelling, so detaching or editing a note using the lowercased key would
-- match nothing and silently do nothing.
--
-- Entries therefore carry both: the key matches listings, `brand` addresses
-- the row.
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
               'retailer_id', r.id,
               'brand',       s.brand,
               'label',       r.label,
               'template',    r.url_template,
               'note',        s.note
             ) ORDER BY r.label
           ) AS entries
    FROM public.user_brand_sources s
    JOIN public.user_retailers r ON r.id = s.retailer_id
    WHERE s.user_id = auth.uid()
    GROUP BY lower(btrim(s.brand))
  ) t;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_brand_sources() TO authenticated;
