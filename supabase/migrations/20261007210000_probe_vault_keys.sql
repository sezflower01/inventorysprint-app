DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== vault secrets available to migrations ==';
  FOR r IN SELECT name, length(decrypted_secret) AS len FROM vault.decrypted_secrets ORDER BY name LOOP
    RAISE NOTICE '  % (% chars)', rpad(r.name, 40), r.len;
  END LOOP;
END
$p$;
