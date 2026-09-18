-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- New per-rule worker (dry run, all switched-on rules) vs the old code's last
-- real hourly run in cron_run_history.

DO $p$
DECLARE r record; v jsonb; v_at timestamptz;
BEGIN
  FOR r IN SELECT to_jsonb(h) AS j FROM public.cron_run_history h
           WHERE to_jsonb(h)::text LIKE '%repricer-auto-lower-min%'
           ORDER BY (to_jsonb(h)->>'started_at') DESC NULLS LAST LIMIT 1 LOOP
    RAISE NOTICE 'OLD code, last real run %: considered % lowered % skips %',
      r.j->>'started_at', r.j->'detail'->>'considered', r.j->'detail'->>'written', r.j->'detail'->'skip_reasons';
  END LOOP;

  SELECT content::jsonb, created INTO v, v_at FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content LIKE '%rules_due%' AND created > now() - interval '15 minutes'
  ORDER BY created DESC LIMIT 1;
  IF v IS NULL THEN RAISE NOTICE 'new dry run not answered yet'; RETURN; END IF;
  IF v->>'success' = 'false' THEN RAISE NOTICE 'new dry run FAILED: %', v->>'error'; RETURN; END IF;

  RAISE NOTICE 'NEW code dry run %: rules on % due % | considered % | would lower % | skips %', v_at,
    v->'detail'->>'rules_on', v->'detail'->>'rules_due', v->'detail'->>'considered', v->'detail'->>'would_lower', v->'detail'->'skip_reasons';

  RAISE NOTICE '';
  RAISE NOTICE '-- every lower the new code would make --';
  FOR r IN SELECT d->>'asin' AS asin, d->>'current_min' AS cur, d->>'new_min' AS nm, d->>'drop_pct' AS pct,
                  d->>'unit_cost' AS cost, d->>'roi_at_new_min' AS roi, d->>'lowest' AS lowest,
                  d->>'drops_today' AS today, d->>'max_drops_per_day' AS mx
           FROM jsonb_array_elements(v->'detail'->'decisions') d WHERE d->>'action' = 'lower' ORDER BY 1 LOOP
    RAISE NOTICE '  % min % -> % (-%%%) lowest % cost % roi-at-new-min %%% | today %/%', r.asin, r.cur, r.nm, r.pct, r.lowest, r.cost, r.roi, r.today, r.mx;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT count(*) FILTER (WHERE d->>'reason' = 'daily_drop_limit') AS daily_cap,
                  count(*) FILTER (WHERE (d->>'drops_today')::int >= 20) AS paused_legacy
           FROM jsonb_array_elements(v->'detail'->'decisions') d LOOP
    RAISE NOTICE 'daily_drop_limit skips: % (of which paused from the old 5-drop limit: %)', r.daily_cap, r.paused_legacy;
  END LOOP;
END
$p$;
