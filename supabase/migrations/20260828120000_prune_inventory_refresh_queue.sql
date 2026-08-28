-- Retention for inventory_refresh_queue: a work queue was being kept as a
-- permanent log.
--
-- Measured 2026-08-28:
--   success   1,315,822   oldest 2026-07-12   <- never pruned
--   pending         397   oldest 2026-08-28 06:15 (drains fine)
--   error           346   last error 2026-08-04
--
-- The queue itself is HEALTHY -- 397 pending with a last_processed minutes old
-- is a worker keeping up. This migration is not fixing a backlog. It is fixing
-- the fact that completed rows are never removed, so the table grows ~28,000
-- rows/day forever.
--
-- ── WHAT THE BLOAT ACTUALLY COSTS (and what it does not) ──────────────────
--
-- NOT the enqueue. `enqueue_full_inventory_refresh` guards with
-- NOT EXISTS (... status IN ('pending','running')), and
-- inventory_refresh_queue_pending_uniq is a PARTIAL index on exactly that
-- predicate -- so that lookup touches ~400 index entries, not 1.3M. Same for
-- inventory_refresh_queue_drain_idx (partial on status='pending'). An earlier
-- reading of this claimed the enqueue was scanning a growing table; it is not.
--
-- What it does cost:
--   * heap size, and inventory_refresh_queue_user_idx (user_id, status) which
--     is NOT partial and therefore carries all 1.3M entries;
--   * autovacuum/ANALYZE work on a large table -- and this database already
--     has nightly-vacuum-analyze-0345 timing out. Every table that does not
--     need to be big makes that worse.
--
-- ── WHY BOUNDED, AND WHY ITS OWN JOB ──────────────────────────────────────
--
-- A single unbounded DELETE of 1.3M rows would hold a long transaction and
-- generate a large dead-tuple burst on a table the worker writes every minute.
-- More importantly, the established failure mode here is a cleanup that cannot
-- finish inside its window and compounds into the next night; raising the
-- timeout was tried twice and regressed. The prescription is to bound the
-- per-run work instead, which is what p_max_rows does.
--
-- Deliberately NOT folded into nightly-data-cleanup-0330: that job already
-- times out. Adding 1.3M rows of deletion to it would make the exact problem
-- worse.
--
-- ── NO NEW INDEX NEEDED ───────────────────────────────────────────────────
--
-- There is no index on (status, processed_at), and none is added. Roughly 99%
-- of the table matches the delete predicate, so a LIMIT-bounded scan finds its
-- quota almost immediately and stops. Adding a 1.3M-entry index in order to
-- delete 1.3M rows would be self-defeating. There is deliberately no ORDER BY
-- either -- which rows go first does not matter, and sorting 1.3M rows to pick
-- 20,000 would be the most expensive part of the statement.

CREATE OR REPLACE FUNCTION public.prune_inventory_refresh_queue(
  p_keep_days int DEFAULT 3,
  p_max_rows  int DEFAULT 20000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_deleted int;
BEGIN
  -- 3 days is ~24 enqueue cycles at the current '15 */3' cadence -- plenty of
  -- history to debug a drain problem, while keeping the table around 85k rows
  -- instead of unbounded.
  --
  -- COALESCE because a row could in principle reach 'success' without a
  -- processed_at; NULL < anything is NULL, so such a row would otherwise be
  -- immortal. updated_at is NOT NULL, so this always resolves.
  DELETE FROM public.inventory_refresh_queue
  WHERE ctid IN (
    SELECT ctid
    FROM public.inventory_refresh_queue
    WHERE status = 'success'
      AND COALESCE(processed_at, updated_at) < now() - make_interval(days => p_keep_days)
    LIMIT p_max_rows
  );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_inventory_refresh_queue(int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.prune_inventory_refresh_queue(int, int) TO service_role;

-- Minutes 3,13,23,...,53 -- never minute 0.
--
-- That offset is not cosmetic. On 2026-08-22, 16 cron jobs failed to START
-- twice in one day ('job startup timeout') because every job due at :00 asked
-- pg_cron for a background worker simultaneously and exhausted the pool. Any
-- new job here joins the :00 cohort unless it deliberately does not.
--
-- 20,000 rows every 10 minutes = 120,000/hour, so the 1.3M backlog clears in
-- roughly 11 hours. After that a run finds at most ~200 rows (28,000/day
-- arriving against 144 runs/day) and returns almost immediately.
SELECT cron.unschedule('prune-inventory-refresh-queue-10m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-inventory-refresh-queue-10m');

SELECT cron.schedule(
  'prune-inventory-refresh-queue-10m',
  '3-59/10 * * * *',
  $$ SELECT public.prune_inventory_refresh_queue(); $$
);

-- Self-verifying: prove the function runs and report the backlog, rather than
-- reporting success for a statement that merely parsed.
DO $$
DECLARE
  v_deleted   int;
  v_remaining bigint;
BEGIN
  SELECT public.prune_inventory_refresh_queue(3, 5000) INTO v_deleted;

  SELECT count(*) INTO v_remaining
  FROM public.inventory_refresh_queue
  WHERE status = 'success'
    AND COALESCE(processed_at, updated_at) < now() - interval '3 days';

  RAISE NOTICE 'prune: deleted % row(s) in the migration itself; % prunable row(s) remain, clearing at 20k/10min (~% hours).',
    v_deleted, v_remaining, round(v_remaining / 120000.0, 1);
END $$;
