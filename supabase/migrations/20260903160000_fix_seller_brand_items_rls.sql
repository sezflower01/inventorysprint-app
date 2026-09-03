-- Fix: the Seller catalogue reported a match count but listed no items.
--
-- ---- WHAT HAPPENED ------------------------------------------------------
--
-- Reproduced 2026-09-03 for BARGAINFORALL (AK8QL0NFCIUMS, US):
--
--   rollup matched_items                          666
--   the same set computed as the service role     737
--   get_seller_brand_items as authenticated         0
--   seller_catalog_queue rows as authenticated      0
--
-- seller_catalog_queue was created with RLS ENABLED AND NO POLICIES. That is
-- deny-all for every role except the service role, which was the intent -- it
-- is a work queue, not user data. But get_seller_brand_items is SECURITY
-- INVOKER and joins it, so in the browser the join ran as the signed-in user
-- and matched nothing, every time, for every seller.
--
-- The count survived because it comes from seller_brand_catalog_rollup, which
-- DOES carry a policy. So one half of the tab read a table it was allowed to
-- see and the other half silently read nothing -- and an empty result is
-- indistinguishable from "this seller has no matches", which is exactly why
-- it looked like a date filter rather than a permissions failure.
--
-- ---- WHY SECURITY DEFINER RATHER THAN A POLICY --------------------------
--
-- seller_catalog_queue has no user_id -- it is keyed (seller_id, marketplace,
-- asin) because a brand belongs to an ASIN, not to a person. A policy would
-- have to join seller_watchlist per row, on a 345,177-row table, on every
-- expand. Running the function as definer and checking the caller's watch ONCE
-- is both cheaper and easier to reason about.
--
-- The guard matters: as definer this function could otherwise return items for
-- any seller_id a caller cared to pass, including ones they do not watch. The
-- `allowed` CTE ties every row to a watch the caller actually owns.

CREATE OR REPLACE FUNCTION public.get_seller_brand_items(
  p_seller_id   text,
  p_marketplace text,
  p_since       timestamptz DEFAULT NULL,
  p_limit       integer     DEFAULT 500
)
RETURNS TABLE(
  asin         text,
  title        text,
  brand        text,
  image_url    text,
  detected_at  timestamptz,
  still_listed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH allowed AS (
    -- The authorisation check. Definer rights end here: everything below is
    -- scoped to a seller this caller actually watches.
    SELECT w.known_asin_list
    FROM public.seller_watchlist w
    WHERE w.user_id = auth.uid()
      AND w.seller_id = p_seller_id
      AND w.marketplace = p_marketplace
    ORDER BY jsonb_array_length(
      CASE WHEN jsonb_typeof(w.known_asin_list) = 'array' THEN w.known_asin_list ELSE '[]'::jsonb END
    ) DESC
    LIMIT 1
  ),
  ub AS (
    SELECT lower(btrim(brand)) AS b, COALESCE(match_mode,'exact') AS mode
    FROM public.user_brands
    WHERE user_id = auth.uid() AND COALESCE(status,'') <> 'ignore'
      AND btrim(COALESCE(brand,'')) <> ''
  ),
  scope AS (
    SELECT q.asin, ab.brand, ab.title
    FROM public.seller_catalog_queue q
    JOIN public.asin_brand_cache ab ON ab.asin = q.asin
    WHERE q.seller_id = p_seller_id AND q.marketplace = p_marketplace
      AND ab.brand IS NOT NULL AND btrim(ab.brand) <> ''
      AND EXISTS (SELECT 1 FROM allowed)
  ),
  mine AS (
    SELECT s.* FROM scope s WHERE EXISTS (
      SELECT 1 FROM ub u
      WHERE (u.mode <> 'prefix' AND lower(btrim(s.brand)) = u.b)
         OR (u.mode  = 'prefix' AND lower(btrim(s.brand)) LIKE u.b || '%')
    )
  )
  SELECT
    m.asin,
    COALESCE(m.title, d.title) AS title,
    m.brand,
    d.image_url,
    d.detected_at,
    -- Checked against the seller's CURRENT list rather than hardcoded true.
    -- The queue is seeded once, so as sellers drop items a hardcoded true
    -- would quietly assert something false about every stale row.
    COALESCE((SELECT a.known_asin_list @> to_jsonb(m.asin) FROM allowed a), false) AS still_listed
  FROM mine m
  LEFT JOIN LATERAL (
    SELECT (array_agg(l.title     ORDER BY l.detected_at DESC))[1] AS title,
           (array_agg(l.image_url ORDER BY l.detected_at DESC))[1] AS image_url,
           max(l.detected_at) AS detected_at
    FROM public.seller_watch_new_listings l
    WHERE l.asin = m.asin AND l.seller_id = p_seller_id
      AND l.marketplace = p_marketplace AND l.user_id = auth.uid()
  ) d ON true
  WHERE p_since IS NULL OR d.detected_at >= p_since
  ORDER BY d.detected_at DESC NULLS LAST, m.asin
  LIMIT GREATEST(p_limit, 1);
$fn$;

GRANT EXECUTE ON FUNCTION public.get_seller_brand_items(text, text, timestamptz, integer) TO authenticated;

-- Verify the caller-scoped logic. auth.uid() reads request.jwt.claims, so
-- setting the claim is enough -- and NO role switch, deliberately: SET LOCAL
-- ROLE authenticated drops the CLI's elevated role, and the RESET ROLE
-- afterwards restores the bare login user, which cannot write
-- supabase_migrations. That failed the whole transaction and silently rolled
-- back the fix it had just proved. Definer rights make the role switch
-- unnecessary anyway: the body runs as the owner regardless.
DO $$
DECLARE v_seller text := 'AK8QL0NFCIUMS'; v_mkt text := 'US';
        v_user uuid; v_items bigint; v_recent bigint; v_other bigint;
BEGIN
  SELECT user_id INTO v_user FROM public.seller_watchlist
   WHERE seller_id = v_seller AND marketplace = v_mkt LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO v_items
    FROM public.get_seller_brand_items(v_seller, v_mkt, NULL, 5000);
  SELECT count(*) INTO v_recent
    FROM public.get_seller_brand_items(v_seller, v_mkt, timestamptz '2026-09-02 00:00:00+00', 5000);

  -- The guard: a caller who does not watch this seller must get nothing.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_other
    FROM public.get_seller_brand_items(v_seller, v_mkt, NULL, 5000);

  PERFORM set_config('request.jwt.claims', NULL, true);

  RAISE NOTICE 'owner sees: catalogue=% since-2-Sep=% | a stranger sees=%',
    v_items, v_recent, v_other;
END $$;
