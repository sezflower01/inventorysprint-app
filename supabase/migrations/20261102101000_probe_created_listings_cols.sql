DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'created_listings NOT NULL columns without a default:';
  FOR r IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='created_listings'
      AND is_nullable='NO' AND column_default IS NULL
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '   % (%)', r.column_name, r.data_type; END LOOP;
END
$p$;
