-- Which watched sellers have actually produced anything.
--
-- Seller request 2026-09-26: "can I filter the sellers that never added new
-- products, so I can delete them and add different ones". Measured that day:
-- of 999 watches, 182 have never produced a single detection in ~37 days of
-- watching, 815 produced something in the last 30 days, and 2 have gone quiet.
--
-- The 182 split in a way that matters before anyone deletes them:
--   * 74 have a stored baseline (known_asin_list) -- properly seeded, checked
--     for weeks, genuinely adding nothing. These are the ones to drop.
--   * 108 have an EMPTY baseline -- we never got a catalogue for them at all,
--     so "added nothing" is our failure to read the storefront, or a dead
--     storefront, not a quiet seller. Worth seeing separately.
--
-- Returned as an RPC because PostgREST cannot GROUP BY: the alternative is
-- shipping 147k detection rows to the browser to count them there.

CREATE OR REPLACE FUNCTION public.seller_watch_productivity()
RETURNS TABLE (
  seller_id       text,
  marketplace     text,
  detections      integer,
  detections_30d  integer,
  last_detection  timestamptz,
  baseline_asins  integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH me AS (SELECT auth.uid() AS uid),
  det AS (
    SELECT l.seller_id, l.marketplace,
           count(*)::int AS detections,
           count(*) FILTER (WHERE l.detected_at > now() - interval '30 days')::int AS detections_30d,
           max(l.detected_at) AS last_detection
    FROM public.seller_watch_new_listings l
    JOIN me ON l.user_id = me.uid
    GROUP BY l.seller_id, l.marketplace
  )
  SELECT w.seller_id,
         w.marketplace,
         COALESCE(d.detections, 0),
         COALESCE(d.detections_30d, 0),
         d.last_detection,
         COALESCE(jsonb_array_length(
           CASE WHEN jsonb_typeof(w.known_asin_list) = 'array' THEN w.known_asin_list ELSE '[]'::jsonb END
         ), 0)
  FROM public.seller_watchlist w
  JOIN me ON w.user_id = me.uid
  LEFT JOIN det d ON d.seller_id = w.seller_id AND d.marketplace = w.marketplace
  WHERE w.status <> 'cancelled';
$fn$;

REVOKE ALL ON FUNCTION public.seller_watch_productivity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_watch_productivity() TO authenticated;

COMMENT ON FUNCTION public.seller_watch_productivity() IS
  'Per watched seller: total detections, detections in the last 30 days, the most recent one, and how many ASINs are in the stored baseline. Drives the "never added anything" filter on Seller Analyzer. Read-only, scoped to auth.uid().';
