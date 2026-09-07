-- PROBE (read-only): were the recent Momentum Smart evaluations actually
-- inside the Power Hours window?
--
-- The UI showed an eval at "Sep 7, 15:22:28" with $0.00 undercut, and Power
-- Hours is enabled 13:00-03:00 at $0.01. Whether that is a bug depends
-- entirely on which clock 15:22 refers to. The window is evaluated in the
-- ACCOUNT's schedule_timezone (America/Chicago); the UI renders in the
-- BROWSER's timezone. If the browser is not in Chicago those are different
-- hours and the $0.00 may be correct behaviour.
--
-- price_actions.created_at is stored in UTC, so converting it to Chicago
-- settles it without depending on how anything was displayed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_tz text := 'America/Chicago'; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== recent Momentum Smart price actions ========';
  RAISE NOTICE 'window is 13:00-03:00 in % (crosses midnight)', v_tz;
  n := 0;
  FOR r IN
    SELECT pa.created_at,
           to_char(pa.created_at AT TIME ZONE 'UTC', 'HH24:MI') AS utc_hm,
           to_char(pa.created_at AT TIME ZONE v_tz, 'HH24:MI')  AS chicago_hm,
           pa.asin, pa.action_type,
           pa.old_price, pa.new_price,
           left(COALESCE(pa.reason,''), 72) AS reason
    FROM public.repricer_price_actions pa
    WHERE pa.user_id = v_uid
      AND pa.rule_name = 'Momentum Smart'
      AND pa.created_at > now() - interval '6 hours'
    ORDER BY pa.created_at DESC
    LIMIT 14
  LOOP
    n := n + 1;
    RAISE NOTICE '   UTC % | Chicago % | % | % -> % | %',
      r.utc_hm, r.chicago_hm, r.asin,
      COALESCE(r.old_price::text,'-'), COALESCE(r.new_price::text,'-'), r.reason;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no Momentum Smart actions in the last 6 hours)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== do any carry a NON-ZERO undercut since the window opened? ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE reason LIKE '%$0.00 undercut%') AS zero_undercut,
           count(*) FILTER (WHERE reason LIKE '%$0.01 undercut%') AS one_cent_undercut,
           min(created_at AT TIME ZONE v_tz) AS earliest_chicago,
           max(created_at AT TIME ZONE v_tz) AS latest_chicago
    FROM public.repricer_price_actions
    WHERE user_id = v_uid AND rule_name = 'Momentum Smart'
      AND created_at > now() - interval '12 hours'
      AND reason LIKE '%undercut%'
  LOOP
    RAISE NOTICE '   % actions mentioning undercut | % at $0.00 | % at $0.01',
      r.total, r.zero_undercut, r.one_cent_undercut;
    RAISE NOTICE '   spanning % .. % Chicago', r.earliest_chicago, r.latest_chicago;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== when was the rule actually saved, in Chicago time? ========';
  FOR r IN
    SELECT name, updated_at,
           to_char(updated_at AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI') AS saved_chicago,
           daypart_enabled, daypart_start, daypart_end, daypart_undercut_amount
    FROM public.repricer_rules
    WHERE user_id = v_uid AND name = 'Momentum Smart'
  LOOP
    RAISE NOTICE '   saved % Chicago | daypart=% % .. % @ %',
      r.saved_chicago, r.daypart_enabled, r.daypart_start, r.daypart_end, r.daypart_undercut_amount;
  END LOOP;
END
$probe$;
