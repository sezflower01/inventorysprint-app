-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- After COG started outranking asin_cost_overrides (00:45 UTC deploy):
--   1. the auto-lower-min dry run: cost source counts, what would be lowered,
--      and what B0G54FYGXQ / B0G4B3117X now resolve to;
--   2. the inventory_valuation_summary row, once its 10-minute cron re-runs.

DO $p$
DECLARE v_uid uuid; r record; v jsonb; v_at timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT content::jsonb, created INTO v, v_at FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content LIKE '%"cost_source"%' AND created > '2026-09-18 00:45:00+00'
  ORDER BY created DESC LIMIT 1;
  IF v IS NULL THEN
    RAISE NOTICE 'dry run not answered yet';
  ELSE
    RAISE NOTICE 'dry run at %: considered=% would_lower=% skips=%', v_at,
      v->'detail'->>'considered', v->'detail'->>'would_lower', v->'detail'->'skip_reasons';
    FOR r IN SELECT d->>'cost_source' AS src, count(*) AS n FROM jsonb_array_elements(v->'detail'->'decisions') d
             WHERE d ? 'cost_source' GROUP BY 1 ORDER BY 2 DESC LOOP
      RAISE NOTICE '  cost source %: %', r.src, r.n;
    END LOOP;
    FOR r IN SELECT d->>'asin' AS asin, d->>'action' AS action, d->>'reason' AS reason, d->>'current_min' AS cur,
                    d->>'new_min' AS nm, d->>'unit_cost' AS cost, d->>'cost_source' AS src
             FROM jsonb_array_elements(v->'detail'->'decisions') d
             WHERE d->>'action' = 'lower' OR d->>'asin' IN ('B0G54FYGXQ','B0G4B3117X','B0DD519KWC') LOOP
      RAISE NOTICE '  % %/% min %->% cost=% (%)', r.asin, r.action, r.reason, r.cur, r.nm, r.cost, r.src;
    END LOOP;
  END IF;

  RAISE NOTICE '';
  FOR r IN SELECT round(value::numeric, 2) AS value, computed_at FROM public.inventory_valuation_summary WHERE user_id = v_uid LOOP
    RAISE NOTICE 'valuation summary: % computed %', r.value, r.computed_at;
  END LOOP;
END
$p$;
