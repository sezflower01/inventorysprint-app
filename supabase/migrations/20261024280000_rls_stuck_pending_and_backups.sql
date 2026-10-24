-- ITEM 2 (apply) and ITEM 3 (apply RLS only, no drops).
--
-- All nine carry no user_id, so none can be owner-scoped. RLS with NO policy is
-- the right posture for every one of them: service_role bypasses RLS, so the
-- workers and migrations that use them keep working, while every anon and
-- authenticated request is denied outright. For the six backups that is also
-- the whole fix -- a dropped table and a table nobody can read are equivalent
-- from the API's point of view, and only one of them is reversible.
--
-- NO DROPS HERE. The evidence for each backup being safe to drop is gathered
-- below and reported; the drop itself waits for approval.

-- ---- ITEM 2: the three live stuck_pending_* tables ----------------------
ALTER TABLE IF EXISTS public.stuck_pending_attempts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.stuck_pending_drain_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.stuck_pending_resolution_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.stuck_pending_attempts IS
  'Live worker state for the stuck-pending drain. RLS enabled with NO policy: no user_id to scope by, and only service_role (which bypasses RLS) needs it.';
COMMENT ON TABLE public.stuck_pending_drain_state IS
  'Live drain cursor for the stuck-pending work. RLS enabled with NO policy -- service_role only.';
COMMENT ON TABLE public.stuck_pending_resolution_log IS
  'Audit log of stuck-pending resolutions, 18,447 rows. Kept deliberately. RLS enabled with NO policy -- service_role only.';

-- ---- ITEM 3: RLS on the six backups, drops deferred --------------------
ALTER TABLE IF EXISTS public.backup_resolve_stuck_pending_20261007  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_cancelled_flag_20261007         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_fee_cache_currency_20261014     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_broken_fee_basis_20261018       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_amazon_verified_prices_20261018 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_channel_backfill_20261019       ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.backup_resolve_stuck_pending_20261007 IS
  'Rollback source for the stuck-pending drain work (2026-10-07), 18,448 rows. KEEP until that work is closed. RLS enabled with no policy -- service_role only.';

DO $p$
DECLARE r record; v_open int := 0; v_t text; v_n bigint; v_refs int;
BEGIN
  RAISE NOTICE '== RLS now, all nine ==';
  FOR r IN
    SELECT c.relname AS t, c.relrowsecurity AS rls,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS pol
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND (c.relname LIKE 'backup_%' OR c.relname LIKE 'stuck_pending_%')
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '   % | RLS % | % policies', rpad(r.t,42), r.rls, r.pol;
    IF NOT r.rls THEN v_open := v_open + 1; END IF;
  END LOOP;
  RAISE NOTICE '   still open: %', v_open;

  RAISE NOTICE '';
  RAISE NOTICE '== any public table ANYWHERE still without RLS? ==';
  FOR r IN
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity ORDER BY 1
  LOOP RAISE NOTICE '   %', r.t; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE -- the public schema is fully covered'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ ITEM 3 EVIDENCE: is each backup safe to drop? ############';
  FOREACH v_t IN ARRAY ARRAY[
    'backup_resolve_stuck_pending_20261007','backup_cancelled_flag_20261007',
    'backup_fee_cache_currency_20261014','backup_broken_fee_basis_20261018',
    'backup_amazon_verified_prices_20261018','backup_channel_backfill_20261019'
  ] LOOP
    RAISE NOTICE '';
    RAISE NOTICE '-- % --', v_t;
    EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
    RAISE NOTICE '   rows %', v_n;

    -- Does any live database object reference it?
    SELECT count(*) INTO v_refs
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND pg_get_functiondef(p.oid) ILIKE '%'||v_t||'%';
    RAISE NOTICE '   referenced by % function(s)', v_refs;

    SELECT count(*) INTO v_refs FROM pg_views
    WHERE schemaname='public' AND definition ILIKE '%'||v_t||'%';
    RAISE NOTICE '   referenced by % view(s)', v_refs;

    SELECT count(*) INTO v_refs FROM cron.job WHERE command ILIKE '%'||v_t||'%';
    RAISE NOTICE '   referenced by % cron job(s)', v_refs;

    SELECT count(*) INTO v_refs
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.confrelid
    WHERE c.relname = v_t;
    RAISE NOTICE '   inbound foreign keys %', v_refs;

    -- Has anything written to it since it was created?
    FOR r IN
      SELECT COALESCE(s.n_tup_ins,0) AS ins, COALESCE(s.n_tup_upd,0) AS upd,
             COALESCE(s.n_tup_del,0) AS del, COALESCE(s.seq_scan,0) AS scans,
             COALESCE(to_char(s.last_analyze,'YYYY-MM-DD'),'never') AS analyzed
      FROM pg_stat_user_tables s JOIN pg_class c ON c.oid=s.relid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND c.relname=v_t
    LOOP
      RAISE NOTICE '   since stats reset: % ins, % upd, % del, % seq scans | analyzed %',
        r.ins, r.upd, r.del, r.scans, r.analyzed;
    END LOOP;
  END LOOP;
END
$p$;
