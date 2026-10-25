DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== columns of net._http_response ==';
  FOR r IN SELECT string_agg(column_name||':'||data_type, ', ' ORDER BY ordinal_position) AS c
           FROM information_schema.columns
           WHERE table_schema='net' AND table_name='_http_response'
  LOOP RAISE NOTICE '%', r.c; END LOOP;

  FOR r IN
    SELECT replace(left(regexp_replace(to_jsonb(h)::text, E'\s+', ' ', 'g'), 1000), '%','%%') AS j
    FROM net._http_response h WHERE h.id = 73936
  LOOP RAISE NOTICE 'ROW 73936: %', r.j; END LOOP;
END
$p$;
