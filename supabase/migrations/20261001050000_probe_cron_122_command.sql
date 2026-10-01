-- READ-ONLY PROBE. The header-extraction regex found nothing on job 122, so
-- look at the command's actual shape. Secret values are masked: only the
-- structure matters, i.e. how the headers argument is spelled.

DO $p$
DECLARE r record; v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 122;
  -- mask anything that looks like a secret or a JWT before printing
  v_cmd := regexp_replace(v_cmd, '([A-Za-z0-9_-]{24,})', 'MASKED', 'g');
  RAISE NOTICE 'job 122 command (masked): %', left(v_cmd, 1200);

  RAISE NOTICE '';
  FOR r IN SELECT jobid, left(regexp_replace(command, '([A-Za-z0-9_-]{24,})', 'MASKED', 'g'), 300) AS cmd
           FROM cron.job WHERE jobid IN (115, 127, 190) ORDER BY jobid LOOP
    RAISE NOTICE 'job % : %', r.jobid, r.cmd;
  END LOOP;
END
$p$;
