-- Superseded before it ever applied.
--
-- This probe assumed sales_orders had an amazon_order_id column. It does not,
-- so the migration errored and blocked the queue behind it. Replaced with a
-- no-op rather than deleted, so the numbering stays continuous and the reason
-- is on the record. The working version is 20260909012000.

DO $noop$
BEGIN
  RAISE NOTICE 'no-op: superseded by 20260909012000 (wrong column name)';
END
$noop$;
