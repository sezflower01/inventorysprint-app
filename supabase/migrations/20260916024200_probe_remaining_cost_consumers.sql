-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Remaining repricer cost readers only matter under specific settings:
--   * repricer-scheduler uses unit cost for a PRICE only with strategy
--     'target_margin' (elsewhere it is a log line; the manual min wins);
--   * sync-inventory-report / sync-intl-marketplace set auto mins from cost
--     only with auto_min_strategy = 'cost_buffer'.
-- Are either in use?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT ru.name, ru.strategy,
                  (SELECT count(*) FROM public.repricer_assignments a WHERE a.rule_id = ru.id AND a.is_enabled) AS enabled
           FROM public.repricer_rules ru WHERE ru.user_id = v_uid LOOP
    RAISE NOTICE '  rule "%": strategy=% enabled_assignments=%', r.name, r.strategy, r.enabled;
  END LOOP;

  FOR r IN SELECT auto_assign_enabled, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_require_cost
           FROM public.user_settings WHERE user_id = v_uid LOOP
    RAISE NOTICE '  user_settings: auto_assign=% auto_minmax=% min_strategy=% max_strategy=% require_cost=%',
      r.auto_assign_enabled, r.auto_minmax_enabled, r.auto_min_strategy, r.auto_max_strategy, r.auto_require_cost;
  END LOOP;
END
$p$;
