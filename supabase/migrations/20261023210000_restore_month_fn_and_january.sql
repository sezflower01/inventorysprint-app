-- January has sat EMPTY for several minutes: pg_net request 37601 never
-- produced a response row and no pl_sync_progress record was created, the same
-- stall that swallowed the probe slices earlier. Restoring from the backup
-- rather than waiting -- a month of P&L must not stay missing while I debug an
-- invocation path.
--
-- The restore is wrapped in a function because this will be needed again: it
-- is the rollback step for every month in the re-pull.
CREATE OR REPLACE FUNCTION public.fec_restore_month(p_user uuid, p_month date)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_cols text; v_n bigint; v_have bigint;
BEGIN
  SELECT count(*) INTO v_have FROM public.fec_repull_backup
  WHERE user_id = p_user AND backup_month = date_trunc('month', p_month)::date;
  IF v_have = 0 THEN
    RAISE EXCEPTION 'no backup for % -- refusing to pretend a restore happened',
      to_char(p_month,'YYYY-MM');
  END IF;

  -- Explicit column list from the catalogue: fec_repull_backup carries two
  -- extra leading columns, so a bare .* has more expressions than the target.
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='financial_events_cache';

  EXECUTE format($q$
    INSERT INTO public.financial_events_cache (%s)
    SELECT %s FROM public.fec_repull_backup
    WHERE user_id = %L AND backup_month = %L
    ON CONFLICT (user_id, event_type, event_date, amazon_order_id, asin) DO NOTHING
  $q$, v_cols, v_cols, p_user, date_trunc('month', p_month)::date);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.fec_restore_month(uuid, date) TO service_role;

DO $p$
DECLARE v_uid uuid; v_n bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_n := public.fec_restore_month(v_uid, '2026-01-01');
  RAISE NOTICE '== January restored: % rows ==', v_n;

  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-01-01')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   diff vs backup: % | % rows', rpad(r.verdict,10), r.rows; END LOOP;

  FOR r IN
    SELECT round(sum(sales),2) AS s, count(*) AS n FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01'
  LOOP RAISE NOTICE '   January now % rows | sales %', r.n, r.s; END LOOP;
END
$p$;
