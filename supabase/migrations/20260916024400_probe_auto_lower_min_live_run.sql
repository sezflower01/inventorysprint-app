-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The 13:40 UTC hourly run was the first REAL run of the COG-aware
-- repricer-auto-lower-min. The dry run predicted exactly 3 lowers:
--   B0H4WH84HR 22.19 -> 19.93, B0H355GGTQ 14.21 -> 13.98, B004J0FPFW 7.15 -> 7.09
-- Confirm what it actually wrote (cron_run_history + the assignment rows).

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT to_jsonb(h) AS j FROM public.cron_run_history h
           WHERE to_jsonb(h)::text LIKE '%repricer-auto-lower-min%'
           ORDER BY (to_jsonb(h)->>'started_at') DESC NULLS LAST LIMIT 2 LOOP
    RAISE NOTICE 'run: started=% status=% items=% considered=% would_lower=% written=%',
      r.j->>'started_at', r.j->>'status', r.j->>'items_processed',
      r.j->'detail'->>'considered', r.j->'detail'->>'would_lower', r.j->'detail'->>'written';
    RAISE NOTICE '     skips=%', r.j->'detail'->'skip_reasons';
    RAISE NOTICE '     lowered: %', (SELECT string_agg((d->>'asin') || ' ' || (d->>'current_min') || '->' || (d->>'new_min') || ' cost=' || (d->>'unit_cost') || ' (' || (d->>'cost_source') || ')', '; ')
                                   FROM jsonb_array_elements(r.j->'detail'->'decisions') d WHERE d->>'action' = 'lower');
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT asin, min_price_override, auto_floor_drop_count, updated_at
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND marketplace = 'US' AND asin IN ('B0H4WH84HR','B0H355GGTQ','B004J0FPFW')
           ORDER BY asin LOOP
    RAISE NOTICE '  % min=% drops=% updated=%', r.asin, r.min_price_override, r.auto_floor_drop_count, r.updated_at;
  END LOOP;
END
$p$;
