-- READ-ONLY PROBE. The benchmark result, plus the cache table's own evidence
-- that real traffic is hitting it.

DO $p$
DECLARE r record; v_status int; v_body text;
BEGIN
  SELECT status_code, content INTO v_status, v_body
  FROM net._http_response WHERE id = 222888;

  IF v_status IS NULL THEN
    RAISE NOTICE 'no benchmark result yet';
  ELSE
    RAISE NOTICE 'http % | %', v_status, left(COALESCE(v_body, ''), 900);
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== cache table: is real traffic using it? ==';
  FOR r IN SELECT region, count(*) AS rows, sum(hit_count) AS hits,
                  min(created_at) AS first_written, max(updated_at) AS last_written,
                  count(*) FILTER (WHERE expires_at > now()) AS still_valid
           FROM public.lwa_token_cache GROUP BY region LOOP
    RAISE NOTICE '  % | % row(s) | % hit(s) | % still valid | first % | last %',
      r.region, r.rows, r.hits, r.still_valid, r.first_written, r.last_written;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (empty — nothing has exchanged a token since the cache went live)'; END IF;
END
$p$;
