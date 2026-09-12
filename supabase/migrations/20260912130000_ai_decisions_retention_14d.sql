-- repricer_ai_decisions: 30 days -> 14, which is the dashboard's own
-- recommendation and has been sitting unapplied.
--
-- Measured 2026-09-12: 3,104,905 rows, 2,641 MB total (heap 1,296 MB, indexes
-- 1,345 MB, no TOAST to speak of), oldest row 2026-08-13 -- a full 30 days, so
-- unlike repricer_price_actions this table's retention IS being honoured. It is
-- simply set twice as long as it needs to be.
--
-- Halving the window removes roughly 1.5M rows and ~1.3 GB of logical data.
-- Nearly half of that is index, which is why this table costs so much per row:
-- 1,345 MB of index against 1,296 MB of heap.
--
-- Safe to shorten: nothing has a foreign key INTO repricer_ai_decisions. The
-- fan-out documented in 20260907141000 runs the other way -- deleting a RULE
-- has to rewrite decision rows that reference it -- and is unaffected by how
-- long decisions are kept.
--
-- The drain is deliberately left to the scheduled jobs rather than done here.
-- 1.5M rows will not delete inside this migration's transaction, and the
-- catch-up job added in 20260912110000 is built exactly for this: it now sees
-- the table 16 days behind and works it down over a night or two.

UPDATE public.database_maintenance_settings
   SET retention_days = 14, updated_at = now()
 WHERE table_key = 'repricer_ai_decisions'
   AND retention_days <> 14;

DO $verify$
DECLARE r record;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======== retention now in force ========';
  FOR r IN
    SELECT table_key, retention_days, enabled, payload_keep_days
    FROM public.database_maintenance_settings
    ORDER BY table_key
  LOOP
    RAISE NOTICE '  % keep=% days enabled=% payload_keep=%',
      rpad(r.table_key, 32), lpad(r.retention_days::text, 3), r.enabled,
      COALESCE(r.payload_keep_days::text, '-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what the change makes eligible ========';
  FOR r IN
    SELECT count(*) AS n, pg_size_pretty(
             (pg_total_relation_size('public.repricer_ai_decisions')
              * count(*)::numeric
              / NULLIF((SELECT count(*) FROM public.repricer_ai_decisions), 0))::bigint
           ) AS approx_share
    FROM public.repricer_ai_decisions
    WHERE created_at < now() - interval '14 days'
  LOOP
    RAISE NOTICE '  % rows now past retention, roughly % of the table', r.n, r.approx_share;
  END LOOP;
END $verify$;
