-- Make the brand refresh runnable by a background job on a user's behalf.
--
-- ---- WHY THIS EXISTS ----------------------------------------------------
--
-- refresh_user_brands() is SECURITY INVOKER and reads auth.uid(), so only a
-- signed-in browser can call it. Nothing in the app ever did: measured
-- 2026-09-04, no component, cron or edge function referenced it -- only
-- comments. Every populated brand list in this database was filled by someone
-- running the SQL by hand.
--
-- That is why a new account looked like it would need someone else's brands.
-- It would not: user_brands is a projection of that user's OWN inventory
-- (4,123 of 4,124 rows came from inventory, exactly one was typed). The list
-- was empty because nothing filled it, not because there was nothing to fill
-- it with.
--
-- sync-amazon-inventory runs as the service role and has no auth.uid(), hence
-- the explicit-user variant. The original becomes a thin wrapper so the
-- derivation lives in ONE place -- two copies would drift the first time the
-- 'generic'/'unknown' exclusion list changed.

CREATE OR REPLACE FUNCTION public.refresh_user_brands_for(p_user uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows int;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'refresh_user_brands_for() requires a user';
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
  WHERE i.user_id = p_user
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
  WHERE user_id = p_user
    AND last_seen_at < now() - interval '1 minute'
    AND (asin_count > 0 OR unit_count > 0 OR inbound_count > 0);

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_user_brands_for(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.refresh_user_brands_for(uuid) TO service_role;

-- The browser-facing entry point now delegates, so there is one derivation.
CREATE OR REPLACE FUNCTION public.refresh_user_brands()
RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'refresh_user_brands() requires an authenticated caller';
  END IF;
  RETURN public.refresh_user_brands_for(v_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_user_brands() TO authenticated;

-- Bring every existing account up to date now, since nothing has ever done it
-- automatically. Backfilling here rather than waiting for each user's next
-- inventory sync: their lists are already stale by an unknown amount.
DO $$
DECLARE r RECORD; v int;
BEGIN
  FOR r IN SELECT DISTINCT user_id FROM public.inventory WHERE user_id IS NOT NULL LOOP
    v := public.refresh_user_brands_for(r.user_id);
    RAISE NOTICE '  account %: % brand rows refreshed', r.user_id, v;
  END LOOP;
END $$;
