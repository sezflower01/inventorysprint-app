-- Classify each detected listing against the brands the user carries.
--
-- ── WHY A NEW COLUMN AND NOT source_status ────────────────────────────────
--
-- source_status already means one thing: whether the (now-deleted) source
-- search ran. Its "Done" values -- candidates_found / sourced / no_candidates
-- -- describe a system removed on 2026-08-19, and the 3 rows still holding
-- them are frozen relics. Overloading it with "matches my brand" would corrupt
-- those rows and make one field carry two unrelated ideas.
--
-- ── THE FOUR STATES ───────────────────────────────────────────────────────
--
--   pending   not yet checked
--   matched   brand is one the user carries, and not marked ignore
--   not_mine  brand is known and is NOT one they carry
--   unknown   Amazon returned no brand for this ASIN
--
-- `unknown` is the load-bearing one. The catalog lookup returns a brand about
-- 78% of the time; for the rest Amazon genuinely has none. Without a separate
-- state those fall into not_mine and vanish behind a filter -- which is exactly
-- what made deleting non-matching listings unsafe: 6,161 of 8,181 had no brand
-- and "no match" meant "never looked up".
--
-- An ignored brand resolves to not_mine, NOT to invisible, at the user's
-- explicit request: they want to see what the rule is doing rather than trust
-- it silently.

ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS brand_match_state text NOT NULL DEFAULT 'pending'
    CHECK (brand_match_state IN ('pending', 'matched', 'not_mine', 'unknown')),
  -- Set when a match is included in a digest, so the next digest sends only
  -- what is new. Without it a digest either repeats itself or has to guess a
  -- window, and a repeated alert is how people learn to ignore alerts.
  ADD COLUMN IF NOT EXISTS brand_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_swnl_match_state
  ON public.seller_watch_new_listings (user_id, brand_match_state, detected_at DESC);

-- Drives the digest: matched but not yet sent.
CREATE INDEX IF NOT EXISTS idx_swnl_pending_notify
  ON public.seller_watch_new_listings (user_id, detected_at)
  WHERE brand_match_state = 'matched' AND brand_notified_at IS NULL;

-- Classify everything already looked up, so the state is correct from the
-- outset rather than only for listings detected from now on.
--
-- Deliberately NOT notifying on these: brand_notified_at stays null but the
-- digest worker only looks at rows detected after it starts, so 8,181
-- historical listings cannot arrive as one enormous first email.
UPDATE public.seller_watch_new_listings l
SET brand_match_state = CASE
      WHEN l.brand IS NULL OR trim(l.brand) = '' THEN
        CASE WHEN l.brand_checked_at IS NULL THEN 'pending' ELSE 'unknown' END
      WHEN EXISTS (
        SELECT 1 FROM public.user_brands b
        WHERE b.user_id = l.user_id
          AND lower(trim(b.brand)) = lower(trim(l.brand))
          AND COALESCE(b.status, '') <> 'ignore'
      ) THEN 'matched'
      ELSE 'not_mine'
    END
WHERE brand_match_state = 'pending';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT brand_match_state AS s, count(*) AS n
    FROM public.seller_watch_new_listings GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  %: %', r.s, r.n;
  END LOOP;
END $$;
