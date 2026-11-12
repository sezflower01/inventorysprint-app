-- BACKUP ONLY. This migration DELETES NOTHING.
--
-- Completes the archive begun in 20261112160000, which covered inventory,
-- user_brands and inventory_history. The completeness probe found two more
-- tables that a cleanup would touch:
--
--   auto_activate_runs    10,472 rows -- scheduled-job run records, created
--                         because the copied inventory made that account look
--                         like an active tenant. Marked for deletion.
--
--   user_module_access    12 rows -- the ONLY table where that account holds
--                         rows and the operator holds none. Archived here,
--                         and deliberately NOT marked for deletion. See below.
--
-- ── WHY user_module_access IS ARCHIVED BUT NOT DELETED ───────────────────
--
-- It is not copied data. It cannot be: the operator has zero rows in it, so
-- there was nothing to copy from. These are that account's own permission
-- grants, written by the signup trigger on the day it was created.
--
-- The operator having zero is correct, not a gap. Three independent layers
-- check the admin role BEFORE consulting this table, so an admin needs no
-- rows in it:
--
--   src/hooks/useModuleAccess.ts      `if (isAdmin) return true`
--   _shared/module-access-guard.ts    admins always pass
--   public.has_module_access()        EXISTS(admin) OR EXISTS(grant)
--
-- The last one is the load-bearing one, because it is what the RLS policies
-- call. Verified below rather than asserted.
--
-- Deleting these 12 rows would revoke a real account's real access. That is a
-- deliberate act with a consequence for whoever holds the account, not a
-- side effect of tidying up a copy -- so it stays out of the cleanup.

DO $p$
DECLARE
  v_other uuid;
  v_owner uuid;
  n_runs bigint; n_access bigint;
  a_runs bigint; a_access bigint;
  c_live text; c_arch text;
  r record;
BEGIN
  SELECT id INTO v_other FROM auth.users WHERE id::text LIKE 'e697c7c7%';
  SELECT id INTO v_owner FROM auth.users WHERE id::text LIKE '020dd71f%';
  IF v_other IS NULL THEN
    RAISE NOTICE 'target account not found -- nothing archived';
    RETURN;
  END IF;

  -- ── auto_activate_runs ─────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.archive_copied_auto_activate_runs_20261112 (
    archived_at timestamptz NOT NULL DEFAULT now(),
    source_user_id uuid NOT NULL,
    row_data jsonb NOT NULL
  );
  INSERT INTO public.archive_copied_auto_activate_runs_20261112 (source_user_id, row_data)
  SELECT v_other, to_jsonb(a) FROM public.auto_activate_runs a WHERE a.user_id = v_other;

  -- ── user_module_access ─────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.archive_copied_user_module_access_20261112 (
    archived_at timestamptz NOT NULL DEFAULT now(),
    source_user_id uuid NOT NULL,
    row_data jsonb NOT NULL
  );
  INSERT INTO public.archive_copied_user_module_access_20261112 (source_user_id, row_data)
  SELECT v_other, to_jsonb(m) FROM public.user_module_access m WHERE m.user_id = v_other;

  -- ── VERIFY ─────────────────────────────────────────────────────────────
  SELECT count(*) INTO n_runs FROM public.auto_activate_runs WHERE user_id = v_other;
  SELECT count(*) INTO n_access FROM public.user_module_access WHERE user_id = v_other;
  SELECT count(*) INTO a_runs FROM public.archive_copied_auto_activate_runs_20261112;
  SELECT count(*) INTO a_access FROM public.archive_copied_user_module_access_20261112;

  RAISE NOTICE '=== COUNTS: live vs archived ===';
  RAISE NOTICE 'auto_activate_runs  live %  archived %  %',
    n_runs, a_runs, CASE WHEN n_runs = a_runs THEN 'MATCH' ELSE '*** MISMATCH ***' END;
  RAISE NOTICE 'user_module_access  live %  archived %  %',
    n_access, a_access, CASE WHEN n_access = a_access THEN 'MATCH' ELSE '*** MISMATCH ***' END;

  -- Content checksum over the sorted payloads: a count proves something was
  -- written, a checksum proves it was the right thing -- which is what a
  -- restore actually depends on.
  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_live
    FROM (SELECT to_jsonb(a)::text AS t FROM public.auto_activate_runs a WHERE a.user_id = v_other) x;
  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_arch
    FROM (SELECT row_data::text AS t FROM public.archive_copied_auto_activate_runs_20261112) y;
  RAISE NOTICE 'auto_activate_runs  md5 live %  archived %  -> %',
    left(COALESCE(c_live,'-'),12), left(COALESCE(c_arch,'-'),12),
    CASE WHEN c_live IS NOT DISTINCT FROM c_arch THEN 'IDENTICAL' ELSE '*** DIFFERS ***' END;

  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_live
    FROM (SELECT to_jsonb(m)::text AS t FROM public.user_module_access m WHERE m.user_id = v_other) x;
  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_arch
    FROM (SELECT row_data::text AS t FROM public.archive_copied_user_module_access_20261112) y;
  RAISE NOTICE 'user_module_access  md5 live %  archived %  -> %',
    left(COALESCE(c_live,'-'),12), left(COALESCE(c_arch,'-'),12),
    CASE WHEN c_live IS NOT DISTINCT FROM c_arch THEN 'IDENTICAL' ELSE '*** DIFFERS ***' END;

  -- ── WHAT those 12 grants actually are ──────────────────────────────────
  RAISE NOTICE ' ';
  RAISE NOTICE '=== the 12 grants, so the decision is made with sight of them ===';
  FOR r IN
    SELECT module::text AS m, string_agg(action::text, ', ' ORDER BY action::text) AS acts
    FROM public.user_module_access WHERE user_id = v_other
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  %  ->  %', rpad(r.m, 24), r.acts;
  END LOOP;

  -- ── PROVE the operator needs no rows here ──────────────────────────────
  --
  -- The claim in the header is that an admin passes every check without a
  -- grant row. has_module_access() is what the RLS policies call, so asking
  -- it directly is the strongest available evidence, short of signing in.
  RAISE NOTICE ' ';
  RAISE NOTICE '=== does the operator pass without any grant rows? ===';
  SELECT count(*) INTO n_access FROM public.user_module_access WHERE user_id = v_owner;
  RAISE NOTICE 'operator grant rows: %', n_access;
  FOR r IN
    SELECT m AS module,
           public.has_module_access(v_owner, m::public.app_module, 'view'::public.app_action) AS can_view,
           public.has_module_access(v_owner, m::public.app_module, 'edit'::public.app_action) AS can_edit
    FROM unnest(ARRAY['repricer','inventory','profit_loss','settings']) AS m
  LOOP
    RAISE NOTICE '  has_module_access(operator, %): view=%  edit=%',
      rpad(r.module, 14), r.can_view, r.can_edit;
  END LOOP;
  RAISE NOTICE '-> all true with zero grant rows means the admin bypass is doing';
  RAISE NOTICE '   the work, and the operator is not missing anything.';

  RAISE NOTICE ' ';
  RAISE NOTICE 'Nothing was deleted. Five tables are now archived:';
  RAISE NOTICE '  inventory, user_brands, inventory_history (20261112160000)';
  RAISE NOTICE '  auto_activate_runs, user_module_access     (this migration)';
END $p$;
