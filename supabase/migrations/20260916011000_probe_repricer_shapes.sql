-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- 20260916010000 reported 0 enabled assignments with min ROI on, and every
-- recent evaluation "with no cost". The second is more likely a probe bug
-- (profit_guard not where the jsonpath looked) than a repricer with no costs.
-- Look at the real shapes before drawing conclusions.

DO $p$
DECLARE v_uid uuid; r record; v_j jsonb; k text; v_keys text := '';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== repricer_rules: min-ROI columns ========';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE (to_jsonb(ru)->>'min_roi_enabled')::boolean) AS roi_true,
           count(*) FILTER (WHERE to_jsonb(ru) ? 'min_roi_enabled') AS has_col,
           count(*) FILTER (WHERE COALESCE(to_jsonb(ru)->'min_roi_enabled_marketplace_overrides','{}'::jsonb) <> '{}'::jsonb) AS has_mkt_ovr,
           count(*) FILTER (WHERE (to_jsonb(ru)->>'enable_profit_guard')::boolean) AS guard_on
    FROM public.repricer_rules ru WHERE ru.user_id = v_uid
  LOOP
    RAISE NOTICE '  rules: %  has min_roi_enabled column: %  min_roi_enabled=true: %  with marketplace overrides: %  enable_profit_guard=true: %',
      r.n, r.has_col, r.roi_true, r.has_mkt_ovr, r.guard_on;
  END LOOP;
  FOR r IN SELECT ru.id, to_jsonb(ru)->>'name' AS name, to_jsonb(ru)->>'min_roi_enabled' AS roi_on,
                  to_jsonb(ru)->'min_roi_enabled_marketplace_overrides' AS ovr,
                  (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = ru.id
                     AND COALESCE((to_jsonb(a)->>'is_enabled')::boolean,false)) AS enabled_assignments
           FROM public.repricer_rules ru WHERE ru.user_id = v_uid ORDER BY 5 DESC LIMIT 8 LOOP
    RAISE NOTICE '    rule "%" min_roi_enabled=% overrides=% enabled_assignments=%', r.name, r.roi_on, r.ovr, r.enabled_assignments;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== repricer_ai_decisions: newest row, top-level keys and where cost lives ========';
  SELECT to_jsonb(d) INTO v_j FROM public.repricer_ai_decisions d
  WHERE d.user_id = v_uid ORDER BY d.created_at DESC LIMIT 1;
  FOR k IN SELECT jsonb_object_keys(v_j) ORDER BY 1 LOOP
    v_keys := v_keys || k || ' ';
  END LOOP;
  RAISE NOTICE '  keys: %', v_keys;
  RAISE NOTICE '  any path containing "unit_cost": %',
    (SELECT string_agg(p::text, ' | ') FROM (
       SELECT jsonb_path_query(v_j, 'lax $.**.unit_cost') AS p LIMIT 3) s);
  RAISE NOTICE '  any path containing "unitCost": %',
    (SELECT string_agg(p::text, ' | ') FROM (
       SELECT jsonb_path_query(v_j, 'lax $.**.unitCost') AS p LIMIT 3) s);
  RAISE NOTICE '  any "cost_source"/"costSource": % / %',
    (SELECT string_agg(p::text, ' | ') FROM (SELECT jsonb_path_query(v_j, 'lax $.**.cost_source') AS p LIMIT 2) s),
    (SELECT string_agg(p::text, ' | ') FROM (SELECT jsonb_path_query(v_j, 'lax $.**.costSource') AS p LIMIT 2) s);

  RAISE NOTICE '';
  RAISE NOTICE '======== repricer_assignments: cost-ish columns ========';
  SELECT to_jsonb(a) - 'id' INTO v_j FROM public.repricer_assignments a
  WHERE a.user_id = v_uid AND COALESCE((to_jsonb(a)->>'is_enabled')::boolean,false) LIMIT 1;
  v_keys := '';
  FOR k IN SELECT jsonb_object_keys(v_j) ORDER BY 1 LOOP
    IF k ~* 'cost|roi|min|floor|cog' THEN v_keys := v_keys || k || '=' || COALESCE(v_j->>k,'null') || '  '; END IF;
  END LOOP;
  RAISE NOTICE '  %', v_keys;
END
$p$;
