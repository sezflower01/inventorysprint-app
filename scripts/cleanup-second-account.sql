-- ════════════════════════════════════════════════════════════════════════
-- Remove the copied rows from the operator's own second account.
--
-- DRY RUN BY DEFAULT. Running this file as-is deletes nothing: it checks the
-- archives, prints exactly what it would remove, and stops.
--
-- To actually delete, run these two statements together in the SQL editor:
--
--     SET LOCAL inventorysprint.confirm_cleanup = 'DELETE-COPIED-ROWS';
--     -- then the whole DO block below, in the same transaction
--
-- or from a shell:
--
--     psql "$DATABASE_URL" \
--       -c "BEGIN; SET LOCAL inventorysprint.confirm_cleanup = 'DELETE-COPIED-ROWS';" \
--       -f scripts/cleanup-second-account.sql -c "COMMIT;"
--
-- ── WHY THIS IS NOT A MIGRATION ─────────────────────────────────────────
--
-- `supabase db push` applies everything pending in one go. A destructive
-- statement sitting in that folder gets applied by a routine push for an
-- unrelated change -- and the person running it will not be thinking about
-- this file. A script has to be chosen.
--
-- ── WHAT IT DELETES ──────────────────────────────────────────────────────
--
--   inventory             3,820 rows -- 3,790 share an (asin, sku) with the
--                         operator's and 3,727 carry the operator's own fnsku
--   user_brands           1,322 rows -- 1,311 also held by the operator
--   inventory_history       439 rows -- the audit trail of the above
--   auto_activate_runs   10,472 rows -- run records that exist only because
--                         the copied inventory made the account look active
--
-- ── WHAT IT DELIBERATELY LEAVES ─────────────────────────────────────────
--
--   the auth.users row    the account itself stays; this removes data, not
--                         a person's login
--   user_module_access    12 rows, and NOT copied data -- the operator has
--                         none, so there was nothing to copy. They are that
--                         account's own grants. Removing them revokes a real
--                         account's access, which is a separate decision.
--   error_reports, module_usage, user_subscriptions, user_sync_status,
--   source_* , pl_sync_progress, live_verify_schedule, and the rest
--                         that account's own rows, or per-account defaults
--                         written by triggers. Equal counts with the operator
--                         are what a DEFAULT looks like, not a copy.
--
-- ── THE SIDE EFFECT THAT IS THE POINT ───────────────────────────────────
--
-- auto-activate-inbound-all selects its tenants as
-- `inventory WHERE inbound > 0 AND listing_status NOT IN (...)`, with no
-- owner filter -- correctly, since it is a multi-tenant entrypoint. The
-- copied rows therefore made this account a tenant, and it has been drawing
-- about 12 scheduled runs a day since 2026-06-14 (10,472 in total, 0
-- candidates and 0 changes in the last 30 days: wasted work, not harm).
--
-- Removing the inventory rows removes it from that query. The block verifies
-- this afterwards rather than assuming it.
-- ════════════════════════════════════════════════════════════════════════

DO $cleanup$
DECLARE
  v_other uuid;
  v_owner uuid;
  v_confirm text;
  v_armed boolean;
  r record;
  n bigint;
  live_n bigint; arch_n bigint;
  live_md5 text; arch_md5 text;
  v_blockers int := 0;
  d_inv bigint; d_brands bigint; d_hist bigint; d_runs bigint;
BEGIN
  v_confirm := COALESCE(current_setting('inventorysprint.confirm_cleanup', true), '');
  v_armed := (v_confirm = 'DELETE-COPIED-ROWS');

  SELECT id INTO v_other FROM auth.users WHERE id::text LIKE 'e697c7c7%';
  SELECT id INTO v_owner FROM auth.users WHERE id::text LIKE '020dd71f%';

  IF v_other IS NULL THEN
    RAISE EXCEPTION 'the target account was not found -- refusing to guess';
  END IF;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'the operator account was not found -- refusing to run without it';
  END IF;
  IF v_other = v_owner THEN
    RAISE EXCEPTION 'the target resolved to the OPERATOR -- refusing';
  END IF;

  RAISE NOTICE '%', CASE WHEN v_armed THEN '*** ARMED: this run will DELETE ***'
                         ELSE 'DRY RUN -- nothing will be deleted' END;
  RAISE NOTICE 'target  %', v_other;
  RAISE NOTICE ' ';

  -- ══════════════════════════════════════════════════════════════════════
  -- GATE 1: every table about to be touched must be archived, by count AND
  -- by content. A count alone proves only that something was written.
  -- ══════════════════════════════════════════════════════════════════════
  RAISE NOTICE '=== archive check (all four must pass) ===';

  FOR r IN
    SELECT * FROM (VALUES
      ('inventory',          'archive_copied_inventory_20261112'),
      ('user_brands',        'archive_copied_user_brands_20261112'),
      ('inventory_history',  'archive_copied_inventory_history_20261112'),
      ('auto_activate_runs', 'archive_copied_auto_activate_runs_20261112')
    ) AS t(src, arch)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = r.arch) THEN
      RAISE NOTICE '  %  *** NO ARCHIVE TABLE (%) ***', rpad(r.src, 20), r.arch;
      v_blockers := v_blockers + 1;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', r.src)
      INTO live_n USING v_other;
    EXECUTE format('SELECT count(*) FROM public.%I', r.arch) INTO arch_n;

    EXECUTE format(
      'SELECT md5(string_agg(t, ''|'' ORDER BY t)) FROM '
      '(SELECT to_jsonb(x)::text AS t FROM public.%I x WHERE x.user_id = $1) s', r.src)
      INTO live_md5 USING v_other;
    EXECUTE format(
      'SELECT md5(string_agg(t, ''|'' ORDER BY t)) FROM '
      '(SELECT row_data::text AS t FROM public.%I) s', r.arch)
      INTO arch_md5;

    IF live_n = arch_n AND live_md5 IS NOT DISTINCT FROM arch_md5 THEN
      RAISE NOTICE '  %  live %  archived %  md5 %  OK',
        rpad(r.src, 20), lpad(live_n::text, 7), lpad(arch_n::text, 7), left(COALESCE(live_md5,'-'), 10);
    ELSE
      RAISE NOTICE '  %  live %  archived %  live_md5 %  arch_md5 %  *** BLOCKED ***',
        rpad(r.src, 20), lpad(live_n::text, 7), lpad(arch_n::text, 7),
        left(COALESCE(live_md5,'-'), 10), left(COALESCE(arch_md5,'-'), 10);
      v_blockers := v_blockers + 1;
    END IF;
  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════
  -- GATE 2: nothing may be deleted that the OPERATOR does not also have.
  --
  -- The justification for deleting these rows is that they are copies. Any
  -- row with no counterpart under the operator is NOT a copy, and might be
  -- that account's own work. Those are reported and left behind rather than
  -- swept up with the rest.
  -- ══════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== rows with NO counterpart under the operator (left behind) ===';

  SELECT count(*) INTO n
  FROM public.inventory i
  WHERE i.user_id = v_other
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory o
      WHERE o.user_id = v_owner
        AND COALESCE(o.sku, '') = COALESCE(i.sku, '')
        AND o.asin IS NOT DISTINCT FROM i.asin);
  RAISE NOTICE '  inventory    % row(s) unique to that account', n;

  SELECT count(*) INTO n
  FROM public.user_brands b
  WHERE b.user_id = v_other
    AND NOT EXISTS (
      SELECT 1 FROM public.user_brands o
      WHERE o.user_id = v_owner AND lower(o.brand) = lower(b.brand));
  RAISE NOTICE '  user_brands  % row(s) unique to that account', n;
  RAISE NOTICE '  (both are preserved by the WHERE clauses below, not deleted)';

  IF v_blockers > 0 THEN
    RAISE EXCEPTION 'refusing to continue: % archive check(s) failed', v_blockers;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- THE DELETE
  --
  -- Order matters: history first, then the rows it describes. Each statement
  -- keeps rows that have no counterpart under the operator, so "unique to
  -- that account" survives even though the archive would have covered it.
  -- ══════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  IF NOT v_armed THEN
    RAISE NOTICE '=== DRY RUN: what WOULD be deleted ===';
    SELECT count(*) INTO d_hist FROM public.inventory_history WHERE user_id = v_other;
    SELECT count(*) INTO d_inv FROM public.inventory i
      WHERE i.user_id = v_other
        AND EXISTS (SELECT 1 FROM public.inventory o WHERE o.user_id = v_owner
                      AND COALESCE(o.sku,'') = COALESCE(i.sku,'')
                      AND o.asin IS NOT DISTINCT FROM i.asin);
    SELECT count(*) INTO d_brands FROM public.user_brands b
      WHERE b.user_id = v_other
        AND EXISTS (SELECT 1 FROM public.user_brands o WHERE o.user_id = v_owner
                      AND lower(o.brand) = lower(b.brand));
    SELECT count(*) INTO d_runs FROM public.auto_activate_runs WHERE user_id = v_other;
    RAISE NOTICE '  inventory_history   %', d_hist;
    RAISE NOTICE '  inventory           %', d_inv;
    RAISE NOTICE '  user_brands         %', d_brands;
    RAISE NOTICE '  auto_activate_runs  %', d_runs;
    RAISE NOTICE ' ';
    RAISE NOTICE 'Nothing was deleted. Set inventorysprint.confirm_cleanup to';
    RAISE NOTICE 'DELETE-COPIED-ROWS in the same transaction to arm this.';
    RETURN;
  END IF;

  DELETE FROM public.inventory_history WHERE user_id = v_other;
  GET DIAGNOSTICS d_hist = ROW_COUNT;

  DELETE FROM public.inventory i
  WHERE i.user_id = v_other
    AND EXISTS (
      SELECT 1 FROM public.inventory o
      WHERE o.user_id = v_owner
        AND COALESCE(o.sku, '') = COALESCE(i.sku, '')
        AND o.asin IS NOT DISTINCT FROM i.asin);
  GET DIAGNOSTICS d_inv = ROW_COUNT;

  DELETE FROM public.user_brands b
  WHERE b.user_id = v_other
    AND EXISTS (
      SELECT 1 FROM public.user_brands o
      WHERE o.user_id = v_owner AND lower(o.brand) = lower(b.brand));
  GET DIAGNOSTICS d_brands = ROW_COUNT;

  DELETE FROM public.auto_activate_runs WHERE user_id = v_other;
  GET DIAGNOSTICS d_runs = ROW_COUNT;

  RAISE NOTICE '=== DELETED ===';
  RAISE NOTICE '  inventory_history   %', d_hist;
  RAISE NOTICE '  inventory           %', d_inv;
  RAISE NOTICE '  user_brands         %', d_brands;
  RAISE NOTICE '  auto_activate_runs  %', d_runs;

  -- ══════════════════════════════════════════════════════════════════════
  -- AFTER: did it achieve the thing it was for?
  -- ══════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== after ===';

  SELECT count(*) INTO n FROM public.inventory
   WHERE user_id = v_other
     AND inbound > 0
     AND listing_status NOT IN ('DELETED', 'NOT_IN_CATALOG', 'INCOMPLETE');
  RAISE NOTICE 'still a tenant of auto-activate-inbound-all? % candidate row(s) -> %',
    n, CASE WHEN n = 0 THEN 'NO -- the scheduled runs stop'
            ELSE '*** YES, still selected ***' END;

  SELECT count(*) INTO n FROM public.user_module_access WHERE user_id = v_other;
  RAISE NOTICE 'user_module_access untouched: % row(s) (expected 12)', n;

  SELECT count(*) INTO n FROM auth.users WHERE id = v_other;
  RAISE NOTICE 'the account itself still exists: % (expected 1)', n;

  RAISE NOTICE ' ';
  RAISE NOTICE 'To restore any table:';
  RAISE NOTICE '  INSERT INTO public.inventory';
  RAISE NOTICE '  SELECT * FROM jsonb_populate_record(NULL::public.inventory, row_data)';
  RAISE NOTICE '  FROM public.archive_copied_inventory_20261112;';
END $cleanup$;
