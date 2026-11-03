-- RLS AUDIT of THIS project. READ ONLY.
--
-- The Supabase alert of 2026-10-31 names project LoveSync
-- (aygehochmkvuyoowigaa), not InventorySprint (mstibdszibcheodvnprm), and
-- 'aygehochmkvuyoowigaa' appears nowhere in this codebase. So that specific
-- finding is not about this database and cannot be fixed from this repo.
--
-- What IS worth doing is checking whether the same class of problem exists
-- here, because nobody has looked and the check is cheap. The alert's rule was
-- rls_disabled_in_public: a table in the public schema with Row-Level Security
-- off is readable, editable and deletable by anyone holding the project URL
-- and the anon key -- and the anon key ships in the frontend bundle, so
-- "anyone with the URL" means anyone.
--
-- Three distinct failures are checked, because only the first is what the
-- alert measures and the other two are just as exploitable:
--   1. RLS disabled outright
--   2. RLS enabled but NO policies -- locked to clients, but a common sign
--      someone meant to write one; harmless for data, worth knowing
--   3. an explicit GRANT to anon or authenticated on a table, which can hand
--      access over regardless of how careful the policies are
DO $p$
DECLARE r record; v_off int; v_nopol int; v_grant int;
BEGIN
  ------------------------------------------------------------------
  SELECT count(*) INTO v_off
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t.tablename AND c.relrowsecurity);

  RAISE NOTICE '######## 1. PUBLIC TABLES WITH RLS *DISABLED* ########';
  RAISE NOTICE '   this is exactly what the alert flags: % table(s)', v_off;
  IF v_off > 0 THEN
    FOR r IN
      SELECT t.tablename,
             COALESCE((SELECT c.reltuples::bigint FROM pg_class c
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname='public' AND c.relname=t.tablename),0) AS est_rows,
             EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                      WHERE g.table_schema='public' AND g.table_name=t.tablename
                        AND g.grantee IN ('anon','authenticated')) AS granted
      FROM pg_tables t
      WHERE t.schemaname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='public' AND c.relname=t.tablename AND c.relrowsecurity)
      ORDER BY est_rows DESC
    LOOP
      RAISE NOTICE '   % | ~% rows | granted to anon/authenticated: %',
        rpad(r.tablename,44), lpad(r.est_rows::text,9), r.granted;
    END LOOP;
    RAISE NOTICE '';
    RAISE NOTICE '   >>> any row above that is BOTH rls-disabled AND granted is';
    RAISE NOTICE '   >>> reachable with the anon key, which ships in the';
    RAISE NOTICE '   >>> frontend bundle. Those are the urgent ones.';
  ELSE
    RAISE NOTICE '   >>> NONE. Every public table has RLS enabled.';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. RLS ON BUT NO POLICIES ########';
  SELECT count(*) INTO v_nopol
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname='public' AND p.tablename=c.relname);
  RAISE NOTICE '   % table(s). Not a data leak -- RLS with no policy denies', v_nopol;
  RAISE NOTICE '   everything to anon and authenticated -- but it often means a';
  RAISE NOTICE '   policy was intended. Listed so none is a surprise later.';
  FOR r IN
    SELECT c.relname AS t,
           EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                    WHERE g.table_schema='public' AND g.table_name=c.relname
                      AND g.grantee IN ('anon','authenticated')) AS granted
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_policies p
                       WHERE p.schemaname='public' AND p.tablename=c.relname)
    ORDER BY 1 LIMIT 25
  LOOP RAISE NOTICE '      % | granted %', rpad(r.t,44), r.granted; END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. TABLES GRANTED TO anon ########';
  SELECT count(DISTINCT table_name) INTO v_grant
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND grantee='anon';
  RAISE NOTICE '   % table(s) carry an explicit grant to anon', v_grant;
  FOR r IN
    SELECT g.table_name AS t,
           string_agg(DISTINCT g.privilege_type, ',' ORDER BY g.privilege_type) AS privs,
           (SELECT c.relrowsecurity FROM pg_class c
             JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname=g.table_name) AS rls
    FROM information_schema.role_table_grants g
    WHERE g.table_schema='public' AND g.grantee='anon'
    GROUP BY g.table_name ORDER BY 1 LIMIT 25
  LOOP
    RAISE NOTICE '      % | % | rls %', rpad(r.t,36), rpad(r.privs,28), r.rls;
  END LOOP;
  IF v_grant = 0 THEN RAISE NOTICE '      none'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. THE TABLES I CREATED TODAY AND YESTERDAY ########';
  FOR r IN
    SELECT c.relname AS t, c.relrowsecurity AS rls,
           (SELECT count(*) FROM pg_policies p
             WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies,
           EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                    WHERE g.table_schema='public' AND g.table_name=c.relname
                      AND g.grantee IN ('anon','authenticated')) AS granted
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND (c.relname LIKE 'cog_%' OR c.relname LIKE 'collapsed_%'
           OR c.relname LIKE 'revive_%' OR c.relname LIKE 'fec_repull%')
    ORDER BY 1
  LOOP
    RAISE NOTICE '   % | rls % | % policies | granted %',
      rpad(r.t,40), r.rls, lpad(r.policies::text,2), r.granted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
