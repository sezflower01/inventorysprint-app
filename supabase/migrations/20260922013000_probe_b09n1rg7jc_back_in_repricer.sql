-- READ-ONLY PROBE. After clearing the not-buyable flag at 13:39:02, is
-- B09N1RG7JC (US) passing the dispatcher's other gates (rule, min price,
-- rule enabled, not restricted) and has it been evaluated since?
-- Also: how many OTHER listings are flagged not-buyable right now and will
-- only be re-checked at tomorrow's 08:30 nightly scan.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT a.status, a.is_enabled, a.rule_id IS NOT NULL AS has_rule, ru.name AS rule,
                  a.min_price_override, a.max_price_override, a.is_restricted, a.is_listing_inactive_not_buyable AS inactive,
                  to_char(a.last_evaluated_at, 'HH24:MI:SS') AS last_eval, to_char(a.last_dispatch_at, 'HH24:MI:SS') AS last_dispatch,
                  a.last_applied_price, a.last_buybox_status, a.last_skip_reason
           FROM public.repricer_assignments a
           LEFT JOIN public.repricer_rules ru ON ru.id = a.rule_id
           WHERE a.user_id = v_uid AND a.asin = 'B09N1RG7JC' AND a.marketplace = 'US' LOOP
    RAISE NOTICE 'US: % enabled=% | rule % (%) | min % max % | restricted % | not-buyable % | last dispatch % | last eval % | price % BB % | skip %',
      r.status, r.is_enabled, r.has_rule, COALESCE(r.rule, '-'), r.min_price_override, r.max_price_override,
      r.is_restricted, r.inactive, COALESCE(r.last_dispatch, 'never'), COALESCE(r.last_eval, 'never'),
      r.last_applied_price, r.last_buybox_status, COALESCE(r.last_skip_reason, '-');
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT count(*) AS flagged,
                  count(*) FILTER (WHERE a.is_enabled AND a.status = 'active') AS enabled_flagged,
                  count(*) FILTER (WHERE a.marketplace = 'US') AS us
           FROM public.repricer_assignments a
           WHERE a.user_id = v_uid AND a.is_listing_inactive_not_buyable = true LOOP
    RAISE NOTICE 'other listings flagged not-buyable now: % (% enabled, % US) -- re-checked only at the 08:30 nightly scan',
      r.flagged, r.enabled_flagged, r.us;
  END LOOP;
END
$p$;
