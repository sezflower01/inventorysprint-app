DO $p$
DECLARE v_ok boolean; v_id bigint;
BEGIN
  RAISE NOTICE '== ALL DRY RUNS ==';
  FOREACH v_id IN ARRAY ARRAY[38095::bigint,38121,38097,38109,38122,38134] LOOP
    v_ok := public.repull_report(v_id);
  END LOOP;
END
$p$;
