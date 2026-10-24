-- ITEM 4, part 3. READ-ONLY. Split the July difference using the report's own
-- fields. api_clawback_total is recorded by the function, so the +10.48 does
-- not need to be added up by hand.
DO $p$
DECLARE r record; v_api numeric; v_stored numeric; v_claw numeric;
BEGIN
  RAISE NOTICE '== every scalar field the newest July report carries ==';
  FOR r IN
    SELECT j.key, left(j.value::text, 120) AS val
    FROM jsonb_each((SELECT report FROM public.repull_reports
                     WHERE left(month,7)='2026-07'
                     ORDER BY captured_at DESC LIMIT 1)) AS j
    WHERE jsonb_typeof(j.value) IN ('number','boolean','string')
    ORDER BY j.key
  LOOP RAISE NOTICE '   % = %', rpad(r.key,34), r.val; END LOOP;

  SELECT (report->>'api_signed_total')::numeric,
         (report->>'stored_signed_total')::numeric,
         (report->>'api_clawback_total')::numeric
    INTO v_api, v_stored, v_claw
  FROM public.repull_reports WHERE left(month,7)='2026-07'
  ORDER BY captured_at DESC LIMIT 1;

  RAISE NOTICE '';
  RAISE NOTICE '############ THE JULY ARITHMETIC ############';
  RAISE NOTICE '   stored signed total now      %', v_stored;
  RAISE NOTICE '   api signed total (fresh)     %', v_api;
  RAISE NOTICE '   net change if applied        %', round(v_api - v_stored, 2);
  RAISE NOTICE '';
  RAISE NOTICE '   of which clawbacks newly captured  %', v_claw;
  RAISE NOTICE '   leaving a reimbursement-side move  %', round((v_api - v_stored) - v_claw, 2);
  RAISE NOTICE '';
  RAISE NOTICE '   THAT residual is the +10.48 the earlier run flagged.';
END
$p$;
