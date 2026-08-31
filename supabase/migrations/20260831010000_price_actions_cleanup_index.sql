-- Give the batched cleanup an index to find each batch with.
--
-- ── WHY THE BATCHING ALONE DID NOT FIX IT ─────────────────────────────────
--
-- 20260831000000 replaced one huge DELETE with 5,000-row batches, and it still
-- timed out. The batching was right; the assumption underneath it was not.
--
-- That migration argued no index was needed because the table is append-only,
-- so the oldest rows sit physically first and a LIMIT-bounded scan finds its
-- batch immediately. But 10.8 million rows have been deleted from this table
-- over its life -- the maintenance page reports exactly that -- and Postgres
-- reuses the freed space. New rows land in old pages, old rows end up
-- scattered across 6.8 GB, and each batch had to scan a large fraction of the
-- table to collect 5,000 matches. Every batch was nearly as expensive as the
-- single statement it replaced.
--
-- ── WHY BRIN AND NOT BTREE ────────────────────────────────────────────────
--
-- A btree on created_at would be ~50 MB and updated on EVERY insert, on the
-- hottest write path in the system -- reintroducing the write amplification
-- that dropping eight unused indexes on 2026-08-22 removed.
--
-- BRIN stores one summary per range of pages rather than one entry per row.
-- It is a few dozen KB here, its insert cost is close to nothing, and it is
-- built for exactly this shape of query: a range scan over a timestamp that is
-- broadly, if imperfectly, correlated with physical order. Page reuse weakens
-- that correlation but does not destroy it -- reuse is bounded by what recent
-- deletes freed, so most pages still hold a narrow band of timestamps.
--
-- If a later measurement shows BRIN is not being chosen, the answer is a btree
-- and accepting the write cost -- not going back to an unindexed scan.

CREATE INDEX IF NOT EXISTS idx_rpa_created_at_brin
  ON public.repricer_price_actions USING BRIN (created_at)
  WITH (pages_per_range = 32);

COMMENT ON INDEX public.idx_rpa_created_at_brin IS
  'Supports the batched retention delete only. BRIN rather than btree so the hot insert path pays almost nothing; see 20260831010000.';

-- Fresh statistics, or the planner may keep choosing the sequential scan it
-- has been costing on stale numbers.
ANALYZE public.repricer_price_actions;

DO $$
DECLARE
  v_old  BIGINT;
  v_size TEXT;
BEGIN
  SELECT count(*) INTO v_old FROM public.repricer_price_actions
  WHERE created_at < now() - interval '14 days';
  SELECT pg_size_pretty(pg_relation_size('public.idx_rpa_created_at_brin'::regclass)) INTO v_size;
  RAISE NOTICE 'BRIN index on created_at: %.', v_size;
  RAISE NOTICE '% row(s) still older than 14 days. Run "Clean now" again; it should now progress.', v_old;
END $$;
