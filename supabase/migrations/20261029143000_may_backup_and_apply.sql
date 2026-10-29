-- MAY: backup taken, apply REFUSED by its own gate.
--
-- This file originally backed up May and fired the apply. It stopped at the
-- diff check: fec_backup_month copied 3,792 rows and fec_diff_month then
-- reported 3,792 differences -- every row. The apply was never fired.
--
-- Rewritten to a no-op so the migration queue is not blocked by a deliberate
-- exception. The backup it created is real and still in fec_repull_backup for
-- 2026-05-01; the diagnosis of the diff is in the next migration.
DO $p$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-05-01';
  RAISE NOTICE 'May backup rows on file: % (apply was NOT fired)', v_n;
END
$p$;
