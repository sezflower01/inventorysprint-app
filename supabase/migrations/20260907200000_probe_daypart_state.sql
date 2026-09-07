-- PROBE (read-only): is Power Hours actually enabled, and was 15:22 inside it?
--
-- An eval at Sep 7 15:22:28 logged "Target ($28.07) - $0.00 undercut", so the
-- daypart override did not fire. Three different reasons produce that, and
-- they need different answers:
--   a) it was never enabled or saved
--   b) it is enabled but the clock was outside the window
--   c) it is enabled, the clock was inside, and the override is not working
--
-- The window is evaluated in the account's repricer_settings.schedule_timezone,
-- NOT in browser time, so the timestamp shown in the UI is not necessarily the
-- clock the rule used. That distinction is the whole question here.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_tz text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT COALESCE(schedule_timezone,'America/Chicago') INTO v_tz
  FROM public.repricer_settings WHERE user_id = v_uid;
  RAISE NOTICE 'account schedule_timezone: %', v_tz;
  RAISE NOTICE 'right now      UTC: %', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI');
  RAISE NOTICE 'right now  local(%): %', v_tz, to_char(now() AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI');

  RAISE NOTICE '';
  RAISE NOTICE '======== Power Hours settings per rule ========';
  FOR r IN
    SELECT name, undercut_amount,
           daypart_enabled, daypart_start, daypart_end, daypart_undercut_amount,
           updated_at
    FROM public.repricer_rules
    WHERE user_id = v_uid
    ORDER BY daypart_enabled DESC, name
  LOOP
    RAISE NOTICE '   %-26s undercut=% | daypart=% % .. % @ % | updated %',
      left(r.name,26), r.undercut_amount, r.daypart_enabled,
      COALESCE(r.daypart_start,'-'), COALESCE(r.daypart_end,'-'),
      COALESCE(r.daypart_undercut_amount::text,'-'), r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== would the window be active RIGHT NOW? ========';
  FOR r IN
    SELECT name, daypart_start, daypart_end,
           to_char(now() AT TIME ZONE v_tz, 'HH24:MI') AS local_now,
           CASE
             WHEN NOT daypart_enabled THEN 'disabled'
             WHEN daypart_start <= daypart_end THEN
               CASE WHEN to_char(now() AT TIME ZONE v_tz,'HH24:MI') >= daypart_start
                     AND to_char(now() AT TIME ZONE v_tz,'HH24:MI') <  daypart_end
                    THEN 'INSIDE window' ELSE 'outside window' END
             ELSE
               CASE WHEN to_char(now() AT TIME ZONE v_tz,'HH24:MI') >= daypart_start
                      OR to_char(now() AT TIME ZONE v_tz,'HH24:MI') <  daypart_end
                    THEN 'INSIDE window (crosses midnight)' ELSE 'outside window' END
           END AS verdict
    FROM public.repricer_rules
    WHERE user_id = v_uid AND daypart_enabled
  LOOP
    RAISE NOTICE '   % | window % .. % | local now % -> %',
      r.name, r.daypart_start, r.daypart_end, r.local_now, r.verdict;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.repricer_rules WHERE user_id = v_uid AND daypart_enabled) THEN
    RAISE NOTICE '   NO RULE HAS POWER HOURS ENABLED -- that alone explains the $0.00 undercut';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== what Momentum Smart normally undercuts by ========';
  FOR r IN
    SELECT name, undercut_amount, suppressed_bb_undercut, smart_profile, target_anchor
    FROM public.repricer_rules WHERE user_id = v_uid AND name = 'Momentum Smart'
  LOOP
    RAISE NOTICE '   undercut_amount=% | suppressed_bb=% | profile=% | anchor=%',
      r.undercut_amount, r.suppressed_bb_undercut, r.smart_profile, r.target_anchor;
    RAISE NOTICE '   (undercut_amount 0 IS match-exactly -- the "equal" behaviour Power Hours overrides)';
  END LOOP;
END
$probe$;
