-- DRY RUN, second attempt. mode=revive_ghosts with dry_run=true writes nothing.
--
-- The earlier extraction regex required headers:=' with no spaces, and the
-- previous probe printed nothing because the cron command is multi-line, so the
-- NOTICE filter only ever showed its first line. Both fixed here: whitespace is
-- flattened before printing, and the regex tolerates spaces around :=.

DO $p$
DECLARE v_uid uuid; v_cmd text; v_headers jsonb; v_req bigint; v_job int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOREACH v_job IN ARRAY ARRAY[122, 115, 127] LOOP
    SELECT command INTO v_cmd FROM cron.job WHERE jobid = v_job;
    IF v_cmd IS NULL THEN CONTINUE; END IF;
    RAISE NOTICE 'job % shape: %', v_job,
      left(regexp_replace(regexp_replace(v_cmd, '([A-Za-z0-9_.-]{30,})', 'MASKED', 'g'), '\s+', ' ', 'g'), 400);
    SELECT (regexp_match(v_cmd, 'headers\s*:=\s*''(\{.*?\})''::jsonb'))[1]::jsonb INTO v_headers;
    IF v_headers IS NOT NULL THEN
      RAISE NOTICE '  usable header found on job % (keys: %)', v_job, (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_headers) k);
      EXIT;
    END IF;
  END LOOP;

  IF v_headers IS NULL THEN
    RAISE NOTICE 'no usable header on any candidate job — nothing sent';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/bulk-live-verify',
    headers := v_headers,
    body := jsonb_build_object(
      'user_id', v_uid,
      'mode', 'revive_ghosts',
      'dry_run', true,
      'limit', 500
    ),
    timeout_milliseconds := 180000
  ) INTO v_req;

  RAISE NOTICE 'dry run requested as net request %', v_req;
END
$p$;
