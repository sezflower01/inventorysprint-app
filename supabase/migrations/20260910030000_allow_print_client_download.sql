-- Let signed-in users download the print client.
--
-- "Connect Printer" returns "object not found". The file is not missing:
-- access/SprintPrint.exe is 83,076,064 bytes, updated 2026-08-11, and byte-for-
-- byte the same build as print-clients/windows/dist/SprintPrint.exe.
--
-- The only SELECT policy covering the bucket is:
--
--   (bucket_id = 'access') AND ((storage.foldername(name))[1] = auth.uid()::text)
--
-- which requires the object to sit in a folder named after the caller's uid,
-- e.g. access/020dd71f-.../SprintPrint.exe. This object is at the bucket ROOT,
-- so storage.foldername('SprintPrint.exe') has no first element, the comparison
-- is never true, and the read is refused.
--
-- Supabase Storage reports an RLS refusal as "Object not found" on purpose, so
-- it cannot be used to probe which files exist. That is why a permissions
-- problem presented as a deleted file, and why this was never going to be
-- fixed by re-uploading.
--
-- This has never worked for anyone -- it is not a regression from the restart,
-- and it is not per-user. Every authenticated user hits the same wall.
--
-- The fix is deliberately narrow: one named file, SELECT only, authenticated
-- only. The per-user folder rule stays exactly as it is for everything else in
-- the bucket -- which includes Setup_ArbiProSeller.exe, credentials.json and
-- other artifacts that should NOT become readable account-wide.

DROP POLICY IF EXISTS "Authenticated users can download the print client" ON storage.objects;

CREATE POLICY "Authenticated users can download the print client"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'access' AND name = 'SprintPrint.exe');

DO $verify$
DECLARE r record; v_n int := 0;
BEGIN
  RAISE NOTICE '======== SELECT policies now covering the access bucket ========';
  FOR r IN
    SELECT policyname, roles::text AS roles, qual
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT'
      AND COALESCE(qual,'') ILIKE '%access%'
    ORDER BY policyname
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   %  roles=%', r.policyname, r.roles;
    RAISE NOTICE '        %', left(r.qual, 180);
  END LOOP;
  RAISE NOTICE '   % policy/policies', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '======== the object being unlocked ========';
  FOR r IN
    SELECT name, COALESCE((metadata->>'size')::bigint,0) AS bytes, updated_at
    FROM storage.objects WHERE bucket_id = 'access' AND name = 'SprintPrint.exe'
  LOOP
    RAISE NOTICE '   access/%  % bytes  updated %', r.name, r.bytes, r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   Everything else in the bucket keeps the per-user folder rule.';
END $verify$;
