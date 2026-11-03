-- VIEWS are the gap the table-level RLS check cannot see. READ ONLY.
--
-- Section 1 of the audit reported ZERO public tables with RLS disabled, which
-- is the rule the Supabase alert fires on. But section 3 listed
-- active_created_listings and active_inventory with "rls f" while section 1
-- found nothing -- because section 1 reads pg_tables (tables only) and
-- section 3 reads information_schema.role_table_grants, which includes VIEWS.
--
-- That discrepancy matters rather than being a quirk of my queries. A VIEW has
-- no row-level security of its own. Before Postgres 15's security_invoker, a
-- view executes with its OWNER's privileges, so a view over an RLS-protected
-- table returns EVERY row to whoever can select the view -- RLS on the base
-- table does not apply. Granted to anon, and the anon key ships in the
-- frontend bundle, that is the same exposure the alert describes, reached by a
-- different route and invisible to the rule that flags tables.
--
-- So: which views exist in public, are they security_invoker, and who may
-- select them.
DO $p$
DECLARE r record; v_total int; v_anon int; v_invoker int; v_risky int := 0;
BEGIN
  SELECT count(*) INTO v_total
  FROM pg_views WHERE schemaname = 'public';
  RAISE NOTICE '######## PUBLIC VIEWS: % ########', v_total;

  SELECT count(*) INTO v_anon
  FROM pg_views v
  WHERE v.schemaname='public'
    AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                 WHERE g.table_schema='public' AND g.table_name=v.viewname
                   AND g.grantee='anon');
  RAISE NOTICE '   granted to anon : %', v_anon;

  SELECT count(*) INTO v_invoker
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='v'
    AND c.reloptions::text ILIKE '%security_invoker%';
  RAISE NOTICE '   with security_invoker set : %', v_invoker;
  RAISE NOTICE '   >>> a view WITHOUT security_invoker ignores the base table''s';
  RAISE NOTICE '   >>> RLS and returns every row to anyone who can select it.';

  RAISE NOTICE '';
  RAISE NOTICE '   view                                 | anon | invoker | owner';
  FOR r IN
    SELECT v.viewname AS vn,
           EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                    WHERE g.table_schema='public' AND g.table_name=v.viewname
                      AND g.grantee='anon') AS anon_ok,
           COALESCE((SELECT c.reloptions::text ILIKE '%security_invoker%'
                     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relname=v.viewname), false) AS invoker,
           v.viewowner AS owner
    FROM pg_views v WHERE v.schemaname='public'
    ORDER BY 2 DESC, 3, 1
  LOOP
    IF r.anon_ok AND NOT r.invoker THEN v_risky := v_risky + 1; END IF;
    RAISE NOTICE '   % | % | % | %', rpad(r.vn,36),
      rpad(r.anon_ok::text,4), rpad(r.invoker::text,7), r.owner;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '######## THE ONES THAT MATTER ########';
  RAISE NOTICE '   views granted to anon WITHOUT security_invoker: %', v_risky;
  IF v_risky > 0 THEN
    RAISE NOTICE '   >>> each of these can return other users'' rows to an';
    RAISE NOTICE '   >>> unauthenticated caller. On a single-seller database the';
    RAISE NOTICE '   >>> practical blast radius is this seller''s own data -- but';
    RAISE NOTICE '   >>> it is still readable by anyone holding the public URL';
    RAISE NOTICE '   >>> and anon key, which the frontend bundle contains.';
    RAISE NOTICE '';
    RAISE NOTICE '   what each one exposes:';
    FOR r IN
      SELECT v.viewname AS vn, left(pg_get_viewdef(c.oid, true), 150) AS def
      FROM pg_views v
      JOIN pg_class c ON c.relname = v.viewname
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
      WHERE v.schemaname='public'
        AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                     WHERE g.table_schema='public' AND g.table_name=v.viewname
                       AND g.grantee='anon')
        AND NOT COALESCE(c.reloptions::text ILIKE '%security_invoker%', false)
      ORDER BY 1
    LOOP
      RAISE NOTICE '   --- % ---', r.vn;
      RAISE NOTICE '       %', r.def;
    END LOOP;
  ELSE
    RAISE NOTICE '   >>> none. Every anon-readable view is security_invoker.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed. No fix applied.';
END
$p$;
