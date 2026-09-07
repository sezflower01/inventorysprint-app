-- PROBE (read-only): why does deleting a rule hit the statement timeout?
--
-- "Failed to delete rule: canceling statement due to statement timeout" on a
-- rule carrying 2,175 assignments. Deleting 2,175 dependent rows is not
-- inherently slow, so something else is doing the work -- an unindexed foreign
-- key forcing a scan per row, a cascade reaching further than expected, or a
-- per-row trigger.
--
-- The last is a live suspicion in this project: repricer_assignments is 185
-- columns wide and was previously found to be broadcasting every row change
-- over realtime, which dominated database load. If that trigger still fires
-- per row, a cascade over 2,175 rows means 2,175 broadcasts inside one
-- statement.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== what references repricer_rules, and how does it behave on delete? ========';
  FOR r IN
    SELECT c.conname,
           src.relname  AS referencing_table,
           a.attname    AS referencing_column,
           CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                              WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                              WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND tgt.relname = 'repricer_rules'
    ORDER BY src.relname
  LOOP
    RAISE NOTICE '   %.% -> repricer_rules | ON DELETE % | %',
      r.referencing_table, r.referencing_column, r.on_delete, r.conname;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is the referencing column INDEXED? ========';
  -- An unindexed FK column means every parent delete scans the child table.
  FOR r IN
    SELECT src.relname AS tbl, a.attname AS col,
           EXISTS (
             SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid
               AND a.attnum = ANY (i.indkey::smallint[])
               AND i.indkey[0] = a.attnum
           ) AS leading_index,
           (SELECT count(*) FROM pg_class cc WHERE cc.oid = c.conrelid) AS _x,
           pg_size_pretty(pg_total_relation_size(c.conrelid)) AS tbl_size
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND tgt.relname = 'repricer_rules'
  LOOP
    RAISE NOTICE '   %.% | indexed as leading column: % | table %',
      r.tbl, r.col, r.leading_index, r.tbl_size;
    IF NOT r.leading_index THEN
      RAISE NOTICE '      -> UNINDEXED. Every rule delete scans this table.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== triggers on repricer_assignments ========';
  n := 0;
  FOR r IN
    SELECT t.tgname, p.proname,
           CASE WHEN (t.tgtype & 1) = 1 THEN 'ROW' ELSE 'STATEMENT' END AS level,
           CASE WHEN (t.tgtype & 8)  = 8  THEN 'DELETE'
                WHEN (t.tgtype & 16) = 16 THEN 'UPDATE'
                WHEN (t.tgtype & 4)  = 4  THEN 'INSERT' ELSE 'multi' END AS event
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE c.relname = 'repricer_assignments' AND NOT t.tgisinternal
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | % | per % | fn %', r.tgname, r.event, r.level, r.proname;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (no user triggers)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many rows would a delete touch? ========';
  FOR r IN
    SELECT rr.name, count(a.id) AS assignments
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    WHERE rr.name ILIKE '%Momentum Builder%'
    GROUP BY rr.id, rr.name ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   % : % assignments', r.name, r.assignments;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== plan for the delete ========';
  FOR r IN
    EXPLAIN (COSTS ON)
    DELETE FROM public.repricer_rules
     WHERE id = '60b80c70-51e9-4424-9fa5-14840984f4db'
  LOOP
    RAISE NOTICE '   %', r."QUERY PLAN";
  END LOOP;
END
$probe$;
