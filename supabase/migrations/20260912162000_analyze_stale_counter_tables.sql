-- ANALYZE the two tables whose statistics counters report 100% bloat.
--
-- 20260912161000 confirmed ANALYZE corrects the counters: financial_events_cache
-- went from live=1,369 dead=5,633 (80.4% "bloat") to live=117,574 dead=12,445
-- once read from a fresh transaction.
--
-- asin_brand_cache (reltuples 333,354, counters live=0 dead=7,211) and
-- seller_catalog_queue (reltuples 345,177, counters live=0 dead=13,731) show
-- the identical artifact, and neither has ever been analysed or vacuumed. With
-- live=0 the score's bloat ratio is dead/(0+dead) = 100% regardless of what is
-- actually in the table, which is the "worst bloat 100%" costing 15 points.
--
-- ANALYZE samples and updates statistics. It takes no lock that blocks reads
-- or writes and changes no data.

ANALYZE public.asin_brand_cache;
ANALYZE public.seller_catalog_queue;
