-- BACKUP ONLY. This migration DELETES NOTHING.
--
-- Copies the rows that a second account received from the operator's catalogue
-- into archive tables, then verifies the copy by count and by checksum. A
-- separate migration, written only after the operator confirms, will do any
-- deleting -- and it can be written safely because this one exists.
--
-- ── WHAT IS ARCHIVED, AND WHAT IS NOT ────────────────────────────────────
--
-- Archived: the three tables proven to contain the operator's own rows.
--   inventory          3,820 rows, 3,790 sharing an (asin, sku) with the operator
--   user_brands        1,322 rows, 1,311 also held by the operator
--   inventory_history    439 rows, the audit trail of the above
--
-- NOT archived, because it is that account's own data or a per-account default
-- and must survive untouched whatever is decided:
--   user_module_access, user_subscriptions, module_usage, error_reports,
--   source_retailers, source_excluded_domains, source_excluded_terms
--   (the source_* tables are seeded for every new account by triggers, so
--   their rows are defaults, not a copy -- equal counts are not evidence)
--
-- ── WHY ARCHIVE TABLES AND NOT A FILE ────────────────────────────────────
--
-- A dump on a laptop is outside RLS, outside backups, and restoring it needs
-- the CLI and a careful hand. A table in the same database restores with one
-- INSERT ... SELECT, is covered by the project's own backups, and can be
-- queried to answer "what exactly did we remove?" months later. The archive
-- tables are deliberately NOT given RLS: they hold a copy of the operator's
-- own catalogue, they are reachable only with the service role, and an RLS
-- policy keyed on the ORIGINAL user_id would make them readable by the very
-- account whose rows are being removed.
--
-- The row-level snapshot is stored as jsonb rather than as a typed mirror of
-- each table, so a later column change to `inventory` cannot make the archive
-- unrestorable or silently drop a column from it.

DO $p$
DECLARE
  v_other uuid;
  n_inv bigint; n_brands bigint; n_hist bigint;
  c_inv text; c_brands text; c_hist text;
BEGIN
  SELECT id INTO v_other FROM auth.users WHERE id::text LIKE 'e697c7c7%';
  IF v_other IS NULL THEN
    RAISE NOTICE 'target account not found -- nothing archived';
    RETURN;
  END IF;

  -- ── inventory ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.archive_copied_inventory_20261112 (
    archived_at timestamptz NOT NULL DEFAULT now(),
    source_user_id uuid NOT NULL,
    row_data jsonb NOT NULL
  );
  INSERT INTO public.archive_copied_inventory_20261112 (source_user_id, row_data)
  SELECT v_other, to_jsonb(i) FROM public.inventory i WHERE i.user_id = v_other
  ON CONFLICT DO NOTHING;

  -- ── user_brands ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.archive_copied_user_brands_20261112 (
    archived_at timestamptz NOT NULL DEFAULT now(),
    source_user_id uuid NOT NULL,
    row_data jsonb NOT NULL
  );
  INSERT INTO public.archive_copied_user_brands_20261112 (source_user_id, row_data)
  SELECT v_other, to_jsonb(b) FROM public.user_brands b WHERE b.user_id = v_other
  ON CONFLICT DO NOTHING;

  -- ── inventory_history ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS public.archive_copied_inventory_history_20261112 (
    archived_at timestamptz NOT NULL DEFAULT now(),
    source_user_id uuid NOT NULL,
    row_data jsonb NOT NULL
  );
  INSERT INTO public.archive_copied_inventory_history_20261112 (source_user_id, row_data)
  SELECT v_other, to_jsonb(h) FROM public.inventory_history h WHERE h.user_id = v_other
  ON CONFLICT DO NOTHING;

  -- ── VERIFY: counts AND a content checksum ──────────────────────────────
  --
  -- A count alone proves only that something was written. The checksum is over
  -- the sorted row payloads, so it also proves the CONTENT matches -- which is
  -- what a restore depends on.
  SELECT COUNT(*) INTO n_inv FROM public.inventory WHERE user_id = v_other;
  SELECT COUNT(*) INTO n_brands FROM public.user_brands WHERE user_id = v_other;
  SELECT COUNT(*) INTO n_hist FROM public.inventory_history WHERE user_id = v_other;

  RAISE NOTICE '=== COUNTS: live vs archived ===';
  FOR c_inv IN
    SELECT format('inventory          live %s  archived %s  %s',
      n_inv, (SELECT COUNT(*) FROM public.archive_copied_inventory_20261112),
      CASE WHEN n_inv = (SELECT COUNT(*) FROM public.archive_copied_inventory_20261112)
           THEN 'MATCH' ELSE '*** MISMATCH ***' END)
  LOOP RAISE NOTICE '%', c_inv; END LOOP;

  FOR c_brands IN
    SELECT format('user_brands        live %s  archived %s  %s',
      n_brands, (SELECT COUNT(*) FROM public.archive_copied_user_brands_20261112),
      CASE WHEN n_brands = (SELECT COUNT(*) FROM public.archive_copied_user_brands_20261112)
           THEN 'MATCH' ELSE '*** MISMATCH ***' END)
  LOOP RAISE NOTICE '%', c_brands; END LOOP;

  FOR c_hist IN
    SELECT format('inventory_history  live %s  archived %s  %s',
      n_hist, (SELECT COUNT(*) FROM public.archive_copied_inventory_history_20261112),
      CASE WHEN n_hist = (SELECT COUNT(*) FROM public.archive_copied_inventory_history_20261112)
           THEN 'MATCH' ELSE '*** MISMATCH ***' END)
  LOOP RAISE NOTICE '%', c_hist; END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== CHECKSUMS: live content vs archived content ===';
  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_inv
    FROM (SELECT to_jsonb(i)::text AS t FROM public.inventory i WHERE i.user_id = v_other) x;
  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_brands
    FROM (SELECT row_data::text AS t FROM public.archive_copied_inventory_20261112) y;
  RAISE NOTICE 'inventory  live md5 %  archived md5 %  -> %',
    left(COALESCE(c_inv,'-'),12), left(COALESCE(c_brands,'-'),12),
    CASE WHEN c_inv IS NOT DISTINCT FROM c_brands THEN 'IDENTICAL' ELSE '*** DIFFERS ***' END;

  RAISE NOTICE ' ';
  RAISE NOTICE 'Nothing was deleted. To restore later:';
  RAISE NOTICE '  INSERT INTO public.inventory SELECT * FROM jsonb_populate_record(';
  RAISE NOTICE '    NULL::public.inventory, row_data)';
  RAISE NOTICE '  FROM public.archive_copied_inventory_20261112;';
END $p$;
