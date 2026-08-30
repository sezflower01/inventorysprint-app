-- Manually-watched brands, and per-brand prefix matching.
--
-- ── source: inventory | manual ────────────────────────────────────────────
--
-- refresh_user_brands() zeroes any brand it cannot find in inventory, on the
-- assumption it sold out. A brand added by hand and never carried would be
-- zeroed on every refresh and read as "sold out" rather than "watching for
-- it" -- so manual rows are excluded from that step entirely.
--
-- source is NOT overwritten on conflict. A manually-watched brand that later
-- turns up in inventory keeps source = 'manual' and simply gains real counts;
-- how it entered the list is a fact about its history, not its current stock.
--
-- ── match_mode: exact | prefix ────────────────────────────────────────────
--
-- Exact (case-insensitive, trimmed) is the default because prefix matching on
-- short names collides badly with this catalogue: POP would catch POPCORN, and
-- WB / CAT / 2K / Ford are short enough to match unrelated brands. Corona the
-- tool brand would catch Corona the beer.
--
-- But prefix is genuinely wanted for others -- Milwaukee catching "Milwaukee
-- Tool", Disney catching "Disney Store" -- so it is opt-in per brand rather
-- than a global setting. Blanket fuzzy matching and exact-only are both wrong;
-- which one applies is a judgement per brand.

ALTER TABLE public.user_brands
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'inventory'
    CHECK (source IN ('inventory', 'manual')),
  ADD COLUMN IF NOT EXISTS match_mode text NOT NULL DEFAULT 'exact'
    CHECK (match_mode IN ('exact', 'prefix'));

COMMENT ON COLUMN public.user_brands.source IS
  'inventory = derived from stock held; manual = added by hand to watch for. Manual rows are never zeroed by refresh_user_brands().';
COMMENT ON COLUMN public.user_brands.match_mode IS
  'exact = case-insensitive equality (default); prefix = also match brands starting with this. Prefix is opt-in because short names collide.';

CREATE OR REPLACE FUNCTION public.refresh_user_brands()
RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'refresh_user_brands() requires an authenticated caller';
  END IF;

  INSERT INTO public.user_brands AS b
    (user_id, brand, asin_count, unit_count, inbound_count, last_seen_at, updated_at)
  SELECT
    i.user_id, trim(i.brand),
    count(DISTINCT i.asin),
    COALESCE(SUM(COALESCE(i.available,0) + COALESCE(i.reserved,0)), 0),
    COALESCE(SUM(COALESCE(i.inbound,0)), 0),
    now(), now()
  FROM public.inventory i
  WHERE i.user_id = v_uid
    AND i.brand IS NOT NULL
    AND trim(i.brand) <> ''
    AND lower(trim(i.brand)) NOT IN ('0', 'generic', 'unknown', 'n/a', 'none')
  GROUP BY i.user_id, trim(i.brand)
  ON CONFLICT (user_id, brand) DO UPDATE
    SET asin_count    = EXCLUDED.asin_count,
        unit_count    = EXCLUDED.unit_count,
        inbound_count = EXCLUDED.inbound_count,
        last_seen_at  = now(),
        updated_at    = now();
        -- note, status, source and match_mode are all deliberately absent: the
        -- refresh must never overwrite what a human set.

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  UPDATE public.user_brands
  SET asin_count = 0, unit_count = 0, inbound_count = 0, updated_at = now()
  WHERE user_id = v_uid
    -- The whole point of `source`: a manually-watched brand has no inventory
    -- to be missing from, so zeroing it would report "sold out" for something
    -- never carried.
    AND source <> 'manual'
    AND last_seen_at < now() - interval '1 minute'
    AND (asin_count > 0 OR unit_count > 0 OR inbound_count > 0);

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_user_brands() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_user_brands() TO authenticated;

-- Prefix matches are evaluated in the classifier, not here, but the view still
-- needs to agree with it or the filter and the state column would disagree.
--
-- DROP then CREATE, not CREATE OR REPLACE. The view selects l.*, which Postgres
-- expands and FREEZES at creation time. Since this view was first built,
-- seller_watch_new_listings gained brand_checked_at, brand_match_state and
-- brand_notified_at, so the expansion is wider and is_my_brand no longer lands
-- in the same position -- and REPLACE may only append columns, never reorder or
-- rename them. It fails with 42P16 "cannot change name of view column".
--
-- Dropping a view destroys no data. Nothing depends on this one but the app,
-- which reads it and will simply see it reappear in the same transaction.
DROP VIEW IF EXISTS public.seller_new_listings_branded;

CREATE VIEW public.seller_new_listings_branded
WITH (security_invoker = true) AS
SELECT
  l.*,
  (b.brand IS NOT NULL) AS is_my_brand,
  b.unit_count  AS my_brand_units,
  b.asin_count  AS my_brand_asins
FROM public.seller_watch_new_listings l
LEFT JOIN LATERAL (
  SELECT ub.brand, ub.unit_count, ub.asin_count
  FROM public.user_brands ub
  WHERE ub.user_id = l.user_id
    AND COALESCE(ub.status, '') <> 'ignore'
    AND (
      lower(trim(ub.brand)) = lower(trim(l.brand))
      OR (ub.match_mode = 'prefix'
          AND l.brand IS NOT NULL
          AND lower(trim(l.brand)) LIKE lower(trim(ub.brand)) || '%')
    )
  -- Exact wins over prefix when both match, so the counts shown belong to the
  -- most specific brand rather than whichever the planner happened to return.
  ORDER BY (lower(trim(ub.brand)) = lower(trim(l.brand))) DESC, length(ub.brand) DESC
  LIMIT 1
) b ON true;

GRANT SELECT ON public.seller_new_listings_branded TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'user_brands: source + match_mode added; refresh no longer zeroes manual rows.';
  RAISE NOTICE 'Add a watched brand with: insert into user_brands (user_id, brand, source) values (auth.uid(), ''Bosch'', ''manual'');';
END $$;
