-- The two anomalies from 20261112120000. READ ONLY.
--
-- inventory holds 3,820 rows belonging to a NON-owner, and listing_validations
-- holds 1. Neither is proof of the borrowed-credential path on its own: user
-- e697c7c7 holds the `inventory` module and may simply have used the app. But
-- that account has NO SP-API connection, so any inventory it has must have
-- come from somewhere -- and sync-amazon-inventory falls back to the
-- operator's token, while bulk-live-verify uses it unconditionally and writes
-- under whatever user_id it is handed.
--
-- The discriminator is OVERLAP. If the non-owner's SKUs are the operator's
-- SKUs, the rows are the operator's Amazon catalog written into someone else's
-- account. If they are disjoint, they came from somewhere else and this is not
-- the credential path.

DO $p$
DECLARE
  v_owner uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  r record; n bigint; v_overlap bigint; v_total bigint;
BEGIN
  RAISE NOTICE '=== inventory: non-owner rows by user and age ===';
  FOR r IN
    SELECT user_id, COUNT(*) AS rows,
           MIN(created_at)::date AS first_seen,
           MAX(created_at)::date AS last_seen,
           MAX(updated_at)::date AS last_touched,
           COUNT(DISTINCT asin) AS asins,
           COUNT(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_stock
    FROM public.inventory WHERE user_id <> v_owner
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE 'user %  rows %  asins %  with_stock %  created % .. %  updated %',
      left(r.user_id::text,8), r.rows, r.asins, r.with_stock,
      r.first_seen, r.last_seen, r.last_touched;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== THE DISCRIMINATOR: do the non-owner SKUs match the operator''s? ===';
  FOR r IN
    SELECT DISTINCT user_id FROM public.inventory WHERE user_id <> v_owner
  LOOP
    SELECT COUNT(*) INTO v_total FROM public.inventory i WHERE i.user_id = r.user_id;
    SELECT COUNT(*) INTO v_overlap
    FROM public.inventory i
    WHERE i.user_id = r.user_id
      AND EXISTS (
        SELECT 1 FROM public.inventory o
        WHERE o.user_id = v_owner
          AND o.asin IS NOT DISTINCT FROM i.asin
          AND COALESCE(o.sku,'') = COALESCE(i.sku,''));
    RAISE NOTICE 'user %  % of % rows share an (asin, sku) with the operator  -> %',
      left(r.user_id::text,8), v_overlap, v_total,
      CASE WHEN v_total = 0 THEN 'n/a'
           WHEN v_overlap * 100 / v_total >= 80 THEN 'COPY OF THE OPERATOR CATALOGUE'
           WHEN v_overlap = 0 THEN 'disjoint -- not the operator catalogue'
           ELSE 'partial overlap, inspect' END;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== a sample of the non-owner rows ===';
  FOR r IN
    SELECT left(user_id::text,8) AS u, asin, sku, available, listing_status,
           created_at::date AS created
    FROM public.inventory WHERE user_id <> v_owner
    ORDER BY created_at LIMIT 8
  LOOP
    RAISE NOTICE '  % % / %  avail=% status=% created=%',
      r.u, r.asin, COALESCE(r.sku,'(null)'), r.available, COALESCE(r.listing_status,'-'), r.created;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== listing_validations: the single non-owner row ===';
  FOR r IN
    SELECT left(user_id::text,8) AS u, asin, sku, created_at
    FROM public.listing_validations WHERE user_id <> v_owner
  LOOP
    RAISE NOTICE '  user % asin % sku % at %', r.u, COALESCE(r.asin,'-'), COALESCE(r.sku,'-'), r.created_at;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== does user_analyser_readings exist? (the new extension inserts into it) ===';
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='user_analyser_readings') THEN
    RAISE NOTICE 'yes';
  ELSE
    RAISE NOTICE 'NO -- the User Analyser extension''s Save button would fail with a 404';
  END IF;
END $p$;
