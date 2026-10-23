DO $p$
DECLARE v_ok boolean;
BEGIN
  RAISE NOTICE '== March (39326) ==';
  v_ok := public.repull_report(39326);
END
$p$;
