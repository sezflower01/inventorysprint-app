-- READ-ONLY PROBE. Creates nothing, changes nothing. Metadata only -- no file
-- contents are read.
-- Before deleting the two retired desktop installers from the "access"
-- bucket: is the bucket public, and what is each object (size, type, age)?

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, name, public, file_size_limit, created_at FROM storage.buckets WHERE id = 'access' LOOP
    RAISE NOTICE 'bucket %: public=% created=%', r.id, r.public, r.created_at;
  END LOOP;
  FOR r IN SELECT name,
                  round(COALESCE((metadata->>'size')::numeric, 0) / 1048576, 2) AS mb,
                  metadata->>'mimetype' AS mime, created_at, updated_at
           FROM storage.objects WHERE bucket_id = 'access' ORDER BY name LOOP
    RAISE NOTICE '  % | % MB | % | created % | updated %', r.name, r.mb, r.mime, r.created_at::date, r.updated_at::date;
  END LOOP;
  FOR r IN SELECT policyname, cmd, roles::text AS roles, left(COALESCE(qual,''), 160) AS qual
           FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
             AND (COALESCE(qual,'') ILIKE '%access%' OR COALESCE(with_check,'') ILIKE '%access%') LOOP
    RAISE NOTICE '  policy "%" % for % : %', r.policyname, r.cmd, r.roles, r.qual;
  END LOOP;
END
$p$;
