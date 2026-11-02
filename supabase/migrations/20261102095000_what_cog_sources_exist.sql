-- What source values does asin_cog_on_record actually hold? READ ONLY.
-- My ALTER assumed ('import','manual','auto_shipment') and was rejected, so
-- the live data carries something else. Widening a CHECK to whatever happens
-- to be there would be wrong without seeing it first.
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'source values in asin_cog_on_record:';
  FOR r IN
    SELECT COALESCE(source,'(null)') AS src, count(*) AS n
    FROM public.asin_cog_on_record GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.src,24), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'the constraint as it stands now:';
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.asin_cog_on_record'::regclass AND contype = 'c'
  LOOP RAISE NOTICE '   % | %', r.conname, r.def; END LOOP;
END
$p$;
