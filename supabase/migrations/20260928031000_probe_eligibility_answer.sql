-- READ-ONLY PROBE. What Amazon said about the two ASINs checked in
-- 20260928030000, and the stored status now.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT status_code, left(content, 700) AS body FROM net._http_response WHERE id = 120651 LOOP
    RAISE NOTICE 'HTTP % | %', r.status_code, r.body;
  END LOOP;

  FOR r IN SELECT asin, approval_status, to_char(checked_at, 'YYYY-MM-DD HH24:MI') AS checked, marketplace
           FROM public.user_approved_products
           WHERE user_id = v_uid AND asin IN ('B06XB38P47', 'B08CRM22W8') ORDER BY asin LOOP
    RAISE NOTICE '%: % (checked %, %)', r.asin, r.approval_status, r.checked, r.marketplace;
  END LOOP;
END
$p$;
