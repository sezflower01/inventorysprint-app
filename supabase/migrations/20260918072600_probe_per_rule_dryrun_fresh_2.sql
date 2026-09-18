-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Per-rule worker with the 3-hour snapshot freshness guard: summary, every
-- lower it would make (with the snapshot age it relied on), stale skips.

DO $p$
DECLARE r record; v jsonb; v_at timestamptz;
BEGIN
  SELECT content::jsonb, created INTO v, v_at FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content LIKE '%snapshot_age_min%' AND created > now() - interval '15 minutes'
  ORDER BY created DESC LIMIT 1;
  IF v IS NULL THEN RAISE NOTICE 'dry run not answered yet'; RETURN; END IF;

  RAISE NOTICE 'dry run %: rules on % due % | considered % | would lower % | skips %', v_at,
    v->'detail'->>'rules_on', v->'detail'->>'rules_due', v->'detail'->>'considered', v->'detail'->>'would_lower', v->'detail'->'skip_reasons';
  FOR r IN SELECT d->>'asin' AS asin, d->>'current_min' AS cur, d->>'new_min' AS nm, d->>'drop_pct' AS pct,
                  d->>'lowest' AS lowest, d->>'unit_cost' AS cost, d->>'roi_at_new_min' AS roi, d->>'snapshot_age_min' AS age
           FROM jsonb_array_elements(v->'detail'->'decisions') d WHERE d->>'action' = 'lower' ORDER BY 1 LOOP
    RAISE NOTICE '  lower % % -> % (-%%%) lowest % | cost % roi %%% | snapshot % min old', r.asin, r.cur, r.nm, r.pct, r.lowest, r.cost, r.roi, r.age;
  END LOOP;
  FOR r IN SELECT round(avg((d->>'snapshot_age_min')::numeric) / 60, 1) AS avg_h, max((d->>'snapshot_age_min')::numeric) / 60 AS max_h, count(*) AS n
           FROM jsonb_array_elements(v->'detail'->'decisions') d WHERE d->>'reason' = 'stale_competitor_data' LOOP
    RAISE NOTICE 'stale skips: % (average age % h, oldest % h)', r.n, r.avg_h, round(r.max_h, 1);
  END LOOP;
END
$p$;
