-- READ-ONLY PROBE. Same question as 20260922030000, printed on one line:
-- which headers does cron #190 send to sync-sales-orders? Long tokens are
-- redacted; only the header shape matters.

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT length(command) AS len,
                  left(regexp_replace(replace(replace(command, E'\n', ' '), E'\r', ' '),
                       '[A-Za-z0-9_\.\-]{30,}', '<redacted>', 'g'), 900) AS shape
           FROM cron.job WHERE jobid = 190 LOOP
    RAISE NOTICE 'command length % | %', r.len, r.shape;
  END LOOP;
END
$p$;
