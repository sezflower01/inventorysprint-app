-- A durable record of the brands actually carried, with room for the user's
-- own notes on each.
--
-- ── WHY A TABLE AND NOT A VIEW ────────────────────────────────────────────
--
-- `inventory.brand` already answers "what do I hold right now", and a view over
-- it would stay current for free. But a brand disappears from that view the
-- moment its last unit sells and the row is pruned -- taking any research
-- attached to it with it. The point of this table is that knowledge about a
-- brand outlives the stock: "I stopped buying this because of IP takedowns" is
-- worth more six months after the inventory is gone than it was on the day.
--
-- So: counts are refreshed from inventory, notes are the user's and are never
-- touched by the refresh.
--
-- ── NOT AN EXCLUSION LIST ─────────────────────────────────────────────────
--
-- `source_excluded_terms` (kind/value/label) already holds manual exclusions
-- and is deliberately hand-curated -- the user's own brand-risk research is the
-- point, and it must never auto-sync with Amazon's restriction data. This table
-- does not feed it, does not read it, and nothing here should ever be wired to
-- exclude a brand automatically. `status` below is a note to a human, not a
-- switch.
--
-- ── SCALE ─────────────────────────────────────────────────────────────────
--
-- Measured mid-backfill on 2026-08-30: 513 distinct brands across 783 branded
-- ASINs -- about 1.5 ASINs per brand, projecting to roughly 2,000 brands over
-- the full catalogue. A per-brand review of 2,000 names is not a task anyone
-- finishes, so the counts below exist to sort that tail: 38 brands held 10+
-- units and accounted for roughly a third of all stock. Those are the ones
-- worth an opinion.

CREATE TABLE IF NOT EXISTS public.user_brands (
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand         text        NOT NULL,
  -- Refreshed from inventory. Zero is meaningful: a brand once carried and now
  -- sold out, which is exactly the row a view would have lost.
  asin_count    int         NOT NULL DEFAULT 0,
  unit_count    int         NOT NULL DEFAULT 0,
  inbound_count int         NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- The user's own. Never written by refresh_user_brands().
  note          text,
  status        text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brand)
);

CREATE INDEX IF NOT EXISTS idx_user_brands_units
  ON public.user_brands (user_id, unit_count DESC);

ALTER TABLE public.user_brands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own brands" ON public.user_brands;
CREATE POLICY "own brands" ON public.user_brands
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Refresh counts from inventory for the CALLING user.
--
-- SECURITY INVOKER and auth.uid()-scoped rather than taking a user id: a
-- DEFINER function with a p_user_id argument would let any authenticated
-- caller rebuild -- and read the shape of -- another account's brand list.
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
    i.user_id,
    trim(i.brand),
    count(DISTINCT i.asin),
    COALESCE(SUM(COALESCE(i.available,0) + COALESCE(i.reserved,0)), 0),
    COALESCE(SUM(COALESCE(i.inbound,0)), 0),
    now(), now()
  FROM public.inventory i
  WHERE i.user_id = v_uid
    AND i.brand IS NOT NULL
    AND trim(i.brand) <> ''
    -- Amazon returns these as literal brand values on unbranded goods. They
    -- are not brands and would sit at the top of any list sorted by count.
    AND lower(trim(i.brand)) NOT IN ('0', 'generic', 'unknown', 'n/a', 'none')
  GROUP BY i.user_id, trim(i.brand)
  ON CONFLICT (user_id, brand) DO UPDATE
    SET asin_count    = EXCLUDED.asin_count,
        unit_count    = EXCLUDED.unit_count,
        inbound_count = EXCLUDED.inbound_count,
        last_seen_at  = now(),
        updated_at    = now();
        -- note and status deliberately absent: the refresh must never
        -- overwrite what a human wrote.

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- A brand that has fully sold out keeps its row, zeroed, rather than being
  -- deleted -- that is the whole reason this is a table.
  UPDATE public.user_brands
  SET asin_count = 0, unit_count = 0, inbound_count = 0, updated_at = now()
  WHERE user_id = v_uid
    AND last_seen_at < now() - interval '1 minute'
    AND (asin_count > 0 OR unit_count > 0 OR inbound_count > 0);

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_user_brands() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_user_brands() TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'user_brands ready. Populate with: select public.refresh_user_brands();';
  RAISE NOTICE 'Run it AFTER the brand backfill finishes, or it will only capture what has been looked up so far.';
END $$;
