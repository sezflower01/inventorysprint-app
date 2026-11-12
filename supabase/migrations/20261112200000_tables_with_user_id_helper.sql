-- A read-only helper: which public tables carry a user_id?
--
-- The isolation test (scripts/new-user-isolation-test.ts) needs to check
-- EVERY table that can hold rows for an account, not a list someone typed out
-- once. A hand-maintained list is how the next table gets missed -- there are
-- 891 migrations in this project and nobody remembers all of them.
--
-- The script runs without this function, falling back to a short keyed list
-- and saying so. This exists so it does not have to.
--
-- Not SECURITY DEFINER: information_schema is readable by the caller anyway,
-- and a definer function returning table names would be a small, needless
-- widening. Execute is granted to service_role only -- the script runs with
-- that key, and nothing in the app needs this.

CREATE OR REPLACE FUNCTION public.fn_tables_with_user_id()
RETURNS TABLE (table_name text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.table_name::text
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = 'public'
    AND c.column_name = 'user_id'
    AND c.data_type = 'uuid'
    AND t.table_type = 'BASE TABLE'
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.fn_tables_with_user_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tables_with_user_id() TO service_role;

COMMENT ON FUNCTION public.fn_tables_with_user_id() IS
  'Read-only. Lists public base tables with a uuid user_id column. Used by the new-user isolation test so its coverage cannot silently fall behind the schema.';

DO $p$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.fn_tables_with_user_id();
  IF n < 20 THEN
    RAISE EXCEPTION 'fn_tables_with_user_id returned only % tables; that cannot be right', n;
  END IF;
  RAISE NOTICE 'fn_tables_with_user_id: % tables carry a uuid user_id', n;
END $p$;
