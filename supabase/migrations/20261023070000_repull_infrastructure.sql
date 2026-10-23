-- Re-pull machinery: ONE backup table and ONE diff function, reused for every
-- month. Built because items 2 and 3 repeat the same backup / resync / diff
-- cycle about ten times, and ten hand-written copies is ten chances to get the
-- date boundary or the ignore-list subtly different between months -- which
-- would make the months non-comparable, defeating the point of diffing them.
--
-- The backup table is append-only and keyed by month, so it doubles as the
-- single rollback source for the whole exercise:
--
--   DELETE FROM public.financial_events_cache
--    WHERE user_id = <uid> AND event_date >= '2026-01-01' AND event_date <= '2026-01-31';
--   INSERT INTO public.financial_events_cache
--   SELECT (f).* FROM public.fec_repull_backup f WHERE backup_month = '2026-01-01';

CREATE TABLE IF NOT EXISTS public.fec_repull_backup AS
SELECT NULL::date AS backup_month, now() AS backed_up_at, f.*
FROM public.financial_events_cache f WHERE false;

COMMENT ON TABLE public.fec_repull_backup IS
  'Pre-resync snapshots of financial_events_cache, one batch per backup_month. Rollback source for the 2026 adjustment re-pull (clawback capture + _adjEvtIdx key fix). Safe to drop once the re-pull is accepted.';

/**
 * Snapshot one month. Returns rows captured. Refuses to double-snapshot a
 * month that is already backed up, so re-running a step cannot overwrite the
 * pristine copy with an already-resynced one -- that would destroy the only
 * rollback source at the exact moment it is needed.
 */
CREATE OR REPLACE FUNCTION public.fec_backup_month(p_user uuid, p_month date)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_existing bigint; v_n bigint;
BEGIN
  SELECT count(*) INTO v_existing FROM public.fec_repull_backup
  WHERE backup_month = date_trunc('month', p_month)::date;

  IF v_existing > 0 THEN
    RAISE NOTICE '   backup for % already exists (% rows) -- keeping the ORIGINAL',
      to_char(p_month,'YYYY-MM'), v_existing;
    RETURN v_existing;
  END IF;

  INSERT INTO public.fec_repull_backup
  SELECT date_trunc('month', p_month)::date, now(), f.*
  FROM public.financial_events_cache f
  WHERE f.user_id = p_user
    AND f.event_date >= date_trunc('month', p_month)::date
    AND f.event_date <  (date_trunc('month', p_month) + interval '1 month')::date;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

/**
 * Diff one month: backup vs live, by upsert key.
 *
 * Money is compared by stripping non-money columns out of to_jsonb(row), so a
 * column added later is compared automatically rather than silently skipped.
 * The ignore list is the single place that decides what "money" means for every
 * month in this exercise.
 */
CREATE OR REPLACE FUNCTION public.fec_diff_month(p_user uuid, p_month date)
RETURNS TABLE (
  verdict text, event_type text, event_date date,
  amazon_order_id text, asin text,
  before_money jsonb, after_money jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH ign AS (
    SELECT ARRAY[
      'backup_month','backed_up_at',
      'id','created_at','updated_at',
      'raw_event','adjustment_type','seller_sku','quantity','posted_at',
      'sync_trace_id','source','marketplace','marketplace_id'
    ] AS cols
  ), b AS (
    SELECT x.event_type, x.event_date, x.amazon_order_id, x.asin,
           to_jsonb(x) - (SELECT cols FROM ign) AS money
    FROM public.fec_repull_backup x
    WHERE x.user_id = p_user
      AND x.backup_month = date_trunc('month', p_month)::date
  ), l AS (
    SELECT y.event_type, y.event_date, y.amazon_order_id, y.asin,
           to_jsonb(y) - (SELECT cols FROM ign) AS money
    FROM public.financial_events_cache y
    WHERE y.user_id = p_user
      AND y.event_date >= date_trunc('month', p_month)::date
      AND y.event_date <  (date_trunc('month', p_month) + interval '1 month')::date
  )
  SELECT
    CASE
      WHEN b.money IS NULL THEN 'new'
      WHEN l.money IS NULL THEN 'REMOVED'
      WHEN b.money = l.money THEN 'unchanged'
      ELSE 'CHANGED'
    END,
    COALESCE(b.event_type, l.event_type),
    COALESCE(b.event_date, l.event_date),
    COALESCE(b.amazon_order_id, l.amazon_order_id),
    COALESCE(b.asin, l.asin),
    b.money, l.money
  FROM b FULL OUTER JOIN l
    ON  b.event_type = l.event_type
    AND b.event_date = l.event_date
    AND b.amazon_order_id = l.amazon_order_id
    AND b.asin = l.asin;
$fn$;

GRANT EXECUTE ON FUNCTION public.fec_backup_month(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fec_diff_month(uuid, date) TO service_role;

DO $p$
DECLARE v_uid uuid; v_n bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- Snapshot October FRESH, before the collision-fix resync.
  v_n := public.fec_backup_month(v_uid, '2026-10-01');
  RAISE NOTICE '== October snapshot: % rows ==', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== sanity: the diff function against an unchanged month ==';
  RAISE NOTICE '   (nothing has been resynced yet, so October must be all-unchanged)';
  FOR r IN
    SELECT verdict, count(*) AS rows
    FROM public.fec_diff_month(v_uid, '2026-10-01') GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.rows;
  END LOOP;
END
$p$;
