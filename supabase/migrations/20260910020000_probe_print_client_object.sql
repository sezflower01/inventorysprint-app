-- PROBE (read-only): "Connect Printer" returns "object not found".
--
-- What that button does: it asks Supabase Storage for a 10-minute signed URL to
-- SprintPrint.exe in the "access" bucket and triggers a browser download. It
-- does NOT connect to anything. The status pill flips to Connected only when
-- the app can reach http://127.0.0.1:7777 -- i.e. when the downloaded exe is
-- actually RUNNING on the machine.
--
-- So "object not found" is a Storage error and the seller's instinct is right:
-- the file is missing from the bucket. Confirm rather than assume, and see what
-- the bucket does hold.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_found boolean := false;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== does the access bucket exist? ========';
  FOR r IN
    SELECT id, name, public, created_at FROM storage.buckets ORDER BY name
  LOOP
    RAISE NOTICE '   bucket % (public=%) created %', rpad(r.name,24), r.public, r.created_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is SprintPrint.exe in it? ========';
  FOR r IN
    SELECT name, bucket_id,
           COALESCE((metadata->>'size')::bigint, 0) AS bytes,
           created_at, updated_at
    FROM storage.objects
    WHERE bucket_id = 'access'
    ORDER BY updated_at DESC LIMIT 30
  LOOP
    v_found := true;
    RAISE NOTICE '   %  %  bytes=%  updated=%',
      rpad(r.name,42), r.bucket_id, r.bytes, r.updated_at;
  END LOOP;
  IF NOT v_found THEN
    RAISE NOTICE '   (the access bucket is EMPTY)';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== anything named like the print client, anywhere? ========';
  v_found := false;
  FOR r IN
    SELECT bucket_id, name,
           COALESCE((metadata->>'size')::bigint, 0) AS bytes, updated_at
    FROM storage.objects
    WHERE name ILIKE '%sprint%' OR name ILIKE '%print%' OR name ILIKE '%.exe'
    ORDER BY updated_at DESC LIMIT 20
  LOOP
    v_found := true;
    RAISE NOTICE '   %/%  bytes=%  updated=%',
      r.bucket_id, rpad(r.name,40), r.bytes, r.updated_at;
  END LOOP;
  IF NOT v_found THEN
    RAISE NOTICE '   nothing matching sprint / print / .exe in ANY bucket';
    RAISE NOTICE '   -> the download has no source; Connect Printer cannot work';
  END IF;
END
$probe$;
