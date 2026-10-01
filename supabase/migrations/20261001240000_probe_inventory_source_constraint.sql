-- READ-ONLY PROBE. The ghost clears and the sync timestamp advances, but
-- listing_status and source both stay put -- consistent with the status write
-- (source = 'force_relist') being REJECTED outright while the second write,
-- which does not set source, is reverted by the tombstone guard.
--
-- A CHECK constraint on inventory.source would explain the rejection. The
-- revive ignores the error object from supabase-js, so a failed update looks
-- exactly like a successful one from the caller's side.

DO $p$
DECLARE r record; v_ok boolean;
BEGIN
  RAISE NOTICE '== check constraints on public.inventory ==';
  FOR r IN SELECT con.conname, pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'inventory' AND con.contype = 'c'
           ORDER BY con.conname LOOP
    RAISE NOTICE '  % : %', r.conname, left(r.def, 300);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no check constraints)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what values does inventory.source actually hold? ==';
  FOR r IN SELECT COALESCE(source, '<null>') AS src, count(*) AS n
           FROM public.inventory GROUP BY 1 ORDER BY 2 DESC LIMIT 15 LOOP
    RAISE NOTICE '  % : %', r.src, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is force_relist accepted at all? (rolled back) ==';
  BEGIN
    UPDATE public.inventory SET source = 'force_relist'
    WHERE asin = 'B09PJPB34P' AND sku = 'FSG-IM9-UBG1';
    RAISE NOTICE '  source=force_relist accepted';
    RAISE EXCEPTION 'rollback_probe';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'rollback_probe' THEN
        RAISE NOTICE '  (probe rolled back as planned)';
      ELSE
        RAISE NOTICE '  REJECTED: % / %', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$p$;
