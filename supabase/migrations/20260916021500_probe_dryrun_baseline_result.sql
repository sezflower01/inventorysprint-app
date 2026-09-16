-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Summarise the baseline dry run of repricer-auto-lower-min (old code).

DO $p$
DECLARE r record; v jsonb;
BEGIN
  SELECT content::jsonb, created, status_code INTO r
  FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND created > now() - interval '30 minutes'
  ORDER BY created DESC LIMIT 1;

  IF r IS NULL THEN
    RAISE NOTICE 'no dry-run response yet';
    RETURN;
  END IF;
  v := r.content;
  RAISE NOTICE 'response at % status %', r.created, r.status_code;
  RAISE NOTICE 'considered=% would_lower=% written=%',
    v->'detail'->>'considered', v->'detail'->>'would_lower', v->'detail'->>'written';
  RAISE NOTICE 'skip_reasons=%', v->'detail'->'skip_reasons';
  RAISE NOTICE 'decisions carrying cost_source (only the NEW code sets it): %',
    (SELECT count(*) FROM jsonb_array_elements(v->'detail'->'decisions') d WHERE d ? 'cost_source');
END
$p$;
