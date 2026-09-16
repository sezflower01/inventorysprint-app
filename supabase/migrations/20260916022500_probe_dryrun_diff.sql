-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Diff the two dry runs of repricer-auto-lower-min:
--   baseline = old code (inventory.cost), triggered_by cog-change-baseline-dry-run
--   new      = COG-aware code, whose decisions carry cost_source
-- Every assignment whose action/reason/new_min changed is listed, with the
-- cost the new code used, so the hourly run is only allowed on evidence.

DO $p$
DECLARE r record; v_old jsonb; v_new jsonb; v_old_at timestamptz; v_new_at timestamptz;
BEGIN
  SELECT content::jsonb, created INTO v_new, v_new_at
  FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content LIKE '%"cost_source"%'
    AND created > now() - interval '30 minutes'
  ORDER BY created DESC LIMIT 1;

  SELECT content::jsonb, created INTO v_old, v_old_at
  FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND content NOT LIKE '%"cost_source"%'
    AND created > now() - interval '60 minutes'
  ORDER BY created DESC LIMIT 1;

  IF v_new IS NULL THEN RAISE NOTICE 'new-code dry run has not answered yet'; RETURN; END IF;
  IF v_old IS NULL THEN RAISE NOTICE 'baseline dry run not found'; RETURN; END IF;

  RAISE NOTICE 'baseline at %: considered=% would_lower=% skips=%', v_old_at,
    v_old->'detail'->>'considered', v_old->'detail'->>'would_lower', v_old->'detail'->'skip_reasons';
  RAISE NOTICE 'new      at %: considered=% would_lower=% skips=%', v_new_at,
    v_new->'detail'->>'considered', v_new->'detail'->>'would_lower', v_new->'detail'->'skip_reasons';

  RAISE NOTICE '';
  RAISE NOTICE '-- cost source used by the new code (rows that reached the cost step) --';
  FOR r IN SELECT d->>'cost_source' AS src, count(*) AS n
           FROM jsonb_array_elements(v_new->'detail'->'decisions') d
           WHERE d ? 'cost_source' GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  %: %', r.src, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- decisions that CHANGED --';
  FOR r IN
    WITH o AS (SELECT d->>'assignment_id' AS id, d FROM jsonb_array_elements(v_old->'detail'->'decisions') d),
         n AS (SELECT d->>'assignment_id' AS id, d FROM jsonb_array_elements(v_new->'detail'->'decisions') d)
    SELECT n.d->>'asin' AS asin,
           o.d->>'action' AS old_action, o.d->>'reason' AS old_reason,
           n.d->>'action' AS new_action, n.d->>'reason' AS new_reason,
           n.d->>'current_min' AS cur_min, n.d->>'new_min' AS new_min,
           n.d->>'unit_cost' AS cost, n.d->>'cost_source' AS src,
           n.d->>'roi_at_new_min' AS roi
    FROM n FULL JOIN o ON o.id = n.id
    WHERE o.d IS NULL OR n.d IS NULL
       OR o.d->>'action' IS DISTINCT FROM n.d->>'action'
       OR o.d->>'reason' IS DISTINCT FROM n.d->>'reason'
       OR o.d->>'new_min' IS DISTINCT FROM n.d->>'new_min'
    ORDER BY 1
  LOOP
    RAISE NOTICE '  % : %/% -> %/%  min % -> %  cost=% (%) roi_at_new_min=%',
      r.asin, r.old_action, r.old_reason, r.new_action, r.new_reason, r.cur_min, r.new_min, r.cost, r.src, r.roi;
  END LOOP;
END
$p$;
