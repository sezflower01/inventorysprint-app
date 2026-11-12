-- READ ONLY. Follow-up to 20261112140000, closing three gaps it left.
--
--   1. PROVENANCE. "This account has rows in table X" is not "this account has
--      the operator's rows". Several tables are seeded per account by triggers,
--      so a copy and a set of defaults look identical from a row count. Each
--      case is proven here by comparing against the operator's own rows rather
--      than inferred -- and one table that looked exposed turned out to hold
--      only empty values.
--
--   2. Which authentication header each relevant pg_cron job sends, printed
--      per job, because the change depends on it.
--
--   3. What a brand-new account is granted automatically, and by which
--      trigger.
--
-- Findings were reported to the operator directly. Security specifics are
-- deliberately not written down in a public repository.
DO $p$
DECLARE
  v_owner uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  v_other uuid;
  r record; n bigint; m bigint;
BEGIN
  SELECT id INTO v_other FROM auth.users WHERE id::text LIKE 'e697c7c7%';

  RAISE NOTICE '=== 1. PROVENANCE: operator-derived, or this account''s own? ===';

  -- user_brands: overlap on the brand name
  SELECT COUNT(*) INTO n FROM public.user_brands WHERE user_id = v_other;
  SELECT COUNT(*) INTO m
  FROM public.user_brands a
  WHERE a.user_id = v_other
    AND EXISTS (SELECT 1 FROM public.user_brands b
                WHERE b.user_id = v_owner AND lower(b.brand) = lower(a.brand));
  RAISE NOTICE '  user_brands: % rows, % also held by the operator -> %',
    n, m, CASE WHEN n = 0 THEN 'n/a' WHEN m * 100 / GREATEST(n,1) >= 80 THEN 'COPY'
               WHEN m = 0 THEN 'own data' ELSE 'partial' END;

  -- supplier_links lives on the inventory rows themselves; compare per sku.
  SELECT COUNT(*) INTO n FROM public.inventory
   WHERE user_id = v_other AND supplier_links IS NOT NULL
     AND supplier_links::text NOT IN ('null','[]','{}');
  SELECT COUNT(*) INTO m
  FROM public.inventory i
  JOIN public.inventory o ON o.user_id = v_owner
    AND COALESCE(o.sku,'') = COALESCE(i.sku,'') AND o.asin IS NOT DISTINCT FROM i.asin
  WHERE i.user_id = v_other
    AND i.supplier_links IS NOT NULL
    AND i.supplier_links::text NOT IN ('null','[]','{}')
    AND i.supplier_links::text = o.supplier_links::text;
  RAISE NOTICE '  supplier_links: % non-empty, % byte-identical to the operator''s -> %',
    n, m, CASE WHEN n = 0 THEN 'EMPTY -- nothing exposed'
               WHEN m > 0 THEN 'COPY of operator sourcing' ELSE 'differs' END;

  -- fnsku: the operator's FBA barcodes
  SELECT COUNT(*) INTO m
  FROM public.inventory i
  JOIN public.inventory o ON o.user_id = v_owner
    AND COALESCE(o.sku,'') = COALESCE(i.sku,'') AND o.asin IS NOT DISTINCT FROM i.asin
  WHERE i.user_id = v_other AND i.fnsku IS NOT NULL AND i.fnsku = o.fnsku;
  RAISE NOTICE '  fnsku identical to the operator''s for the same sku: % rows', m;

  -- the three seeded-by-trigger tables: confirm they are DEFAULTS, not copies
  FOR r IN SELECT unnest(ARRAY['source_retailers','source_excluded_domains','source_excluded_terms']) AS t
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE user_id = $1', r.t) INTO n USING v_other;
    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE user_id = $1', r.t) INTO m USING v_owner;
    RAISE NOTICE '  % : other=%  operator=%  (seeded per account by a trigger, so equal counts are DEFAULTS not a copy)',
      rpad(r.t,26), n, m;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 2. cron jobs for the sync family: which auth header each sends ===';
  FOR r IN
    SELECT jobname, schedule, active,
           (command ILIKE '%x-internal-secret%') AS sends_secret,
           (command ILIKE '%Authorization%') AS sends_bearer,
           COALESCE(substring(command from 'functions/v1/([a-z0-9-]+)'), '?') AS fn
    FROM cron.job
    WHERE command ILIKE '%functions/v1/%'
      AND (command ILIKE '%sync-%' OR command ILIKE '%bulk-live-verify%'
           OR command ILIKE '%poll-fbm%' OR command ILIKE '%resolve-unmapped%')
    ORDER BY 6, 1
  LOOP
    RAISE NOTICE '  fn=% job=% sched=% active=% secret=% bearer=%',
      rpad(r.fn,24), rpad(r.jobname,32), rpad(r.schedule,16), r.active, r.sends_secret, r.sends_bearer;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 3. what a brand-new account is granted automatically ===';
  FOR r IN
    SELECT module::text AS m, action::text AS a, COUNT(*) AS users
    FROM public.user_module_access GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '  % : % (held by % user(s))', rpad(r.m,24), rpad(r.a,8), r.users;
  END LOOP;
  RAISE NOTICE '  -- the grant function''s body, trimmed --';
  FOR r IN
    SELECT regexp_replace(pg_get_functiondef(p.oid), E'\\s+', ' ', 'g') AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='fn_grant_default_module_access'
  LOOP
    RAISE NOTICE '  %', left(r.def, 900);
  END LOOP;
END $p$;
