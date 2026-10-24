-- Regression check: does the fixed detector still reproduce the pairings the
-- old one found, and does the pairing + restatement account for each month's
-- residual? READ-ONLY.
DO $p$
DECLARE v_uid uuid; m record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  FOR m IN SELECT unnest(ARRAY['2026-03-01','2026-04-01','2026-05-01',
                               '2026-06-01','2026-07-01','2026-08-01',
                               '2026-09-01']::date[]) AS d
  LOOP
    PERFORM public.repull_residual_explain(v_uid, m.d);
  END LOOP;
END
$p$;
