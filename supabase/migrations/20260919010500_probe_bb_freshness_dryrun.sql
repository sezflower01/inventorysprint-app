-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Dry run with the new Buy Box status freshness guard (3 h): how many listings
-- does it now refuse, and do the remaining lowers all rest on fresh data
-- (Buy Box status and competitor snapshot)?

DO $p$
DECLARE r record; v jsonb; v_at timestamptz;
BEGIN
  SELECT content::jsonb, created INTO v, v_at FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content LIKE '%bb_status_age_min%' AND created > now() - interval '15 minutes'
  ORDER BY created DESC LIMIT 1;
  IF v IS NULL THEN RAISE NOTICE 'dry run not answered yet'; RETURN; END IF;

  RAISE NOTICE 'dry run %: considered % | would lower % | skips %', v_at,
    v->'detail'->>'considered', v->'detail'->>'would_lower', v->'detail'->'skip_reasons';
  FOR r IN SELECT d->>'asin' AS asin, d->>'current_min' AS cur, d->>'new_min' AS nm, d->>'bb_status_age_min' AS bb_age, d->>'snapshot_age_min' AS snap_age
           FROM jsonb_array_elements(v->'detail'->'decisions') d WHERE d->>'action' = 'lower' LOOP
    RAISE NOTICE '  lower % % -> % | BB status % min old | competitor data % min old', r.asin, r.cur, r.nm, r.bb_age, r.snap_age;
  END LOOP;
  FOR r IN SELECT max((d->>'bb_status_age_min')::numeric) FILTER (WHERE d->>'action' = 'lower') AS max_bb_age_on_lowers,
                  count(*) FILTER (WHERE d->>'reason' = 'stale_buybox_status') AS stale_bb
           FROM jsonb_array_elements(v->'detail'->'decisions') d LOOP
    RAISE NOTICE 'stale Buy Box status skips: % | oldest BB status on any lower: % min', r.stale_bb, r.max_bb_age_on_lowers;
  END LOOP;
END
$p$;
