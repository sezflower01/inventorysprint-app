-- Narrow repricer_price_actions' realtime payload from 52 columns to 18.
--
-- ── WHY THIS TABLE GETS DIFFERENT TREATMENT ───────────────────────────────
--
-- repricer_assignments gets a trigger (20260827120000) because its subscribers
-- did not want the events at all. This table is the opposite case: both of its
-- subscribers genuinely want every INSERT.
--
--   CheckedRecentlyPanel.tsx    INSERT, filter user_id=eq.<uid>
--                               reads id, asin, sku, marketplace, action_type,
--                               trigger_source, old_price, new_price, reason,
--                               success, error_message, error_type, rule_name,
--                               overlay_tag, created_at, update_method
--   AdminErrorNotification.tsx  INSERT, filter action_type=eq.price_change_failed
--                               ignores the payload; calls throttledFetch()
--
-- So suppressing the events would break a working feature. What is wasteful is
-- the payload: repricer-scheduler inserts a price_action on every evaluation
-- including no_change (repricer-scheduler/index.ts, the insert immediately
-- after noChangeUpdate), so this table takes inserts at roughly the same rate
-- as the assignments table takes updates -- and ships 52 columns to deliver
-- the 16 anyone reads.
--
-- A publication column list is the right tool here precisely because it does
-- NOT suppress events. It only shrinks them.
--
-- ⚠️ SYNTAX TRAP, and the reason this migration is not a one-liner:
--
--     ALTER PUBLICATION supabase_realtime SET TABLE public.repricer_price_actions (...)
--
-- is NOT "set the column list for this table". SET TABLE replaces the
-- publication's ENTIRE table list, so that statement would silently drop
-- chat_messages, chat_sessions, automation_runs, automation_results,
-- fnsku_map, pl_sync_progress and repricer_assignments out of realtime. The
-- only safe way to change one table's column list is DROP then ADD, which is
-- what this does, inside one transaction.
--
-- Column lists require every replica-identity column to be present. This table
-- has REPLICA IDENTITY DEFAULT (no migration ever set it to FULL), so that
-- means the primary key, and `id` is in the list below.
--
-- ── CONDITIONAL ON PURPOSE ────────────────────────────────────────────────
--
-- No migration in this repo ever ran ALTER PUBLICATION ... ADD TABLE for
-- repricer_price_actions, yet two components subscribe to it and the feature
-- works -- so it was enabled through the Supabase dashboard, which does not
-- write a migration. That means this file cannot assume the table is in the
-- publication, and must not fail if it is not.

-- Publication column lists are Postgres 15+. On 14 the ADD TABLE below would
-- fail with a syntax error partway through, after the DROP TABLE had already
-- removed the table from the publication -- leaving realtime worse than it
-- started. Fail before touching anything instead.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'publication column lists require Postgres 15+; this server is %. Skip this migration.',
      current_setting('server_version');
  END IF;
END $$;

DO $$
DECLARE
  is_published boolean;
  had_collist  boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'repricer_price_actions'
  ) INTO is_published;

  IF NOT is_published THEN
    RAISE NOTICE 'repricer_price_actions is NOT in supabase_realtime -- nothing to narrow. If CheckedRecentlyPanel still updates live, find out what is delivering those events before trusting this result.';
    RETURN;
  END IF;

  SELECT prattrs IS NOT NULL INTO had_collist
  FROM pg_publication_rel pr
  JOIN pg_publication p ON p.oid = pr.prpubid
  WHERE p.pubname = 'supabase_realtime'
    AND pr.prrelid = 'public.repricer_price_actions'::regclass;

  IF had_collist THEN
    RAISE NOTICE 'repricer_price_actions already has a column list; replacing it with this one.';
  END IF;

  EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.repricer_price_actions';
  EXECUTE $sql$
    ALTER PUBLICATION supabase_realtime ADD TABLE public.repricer_price_actions (
      id,
      user_id,          -- CheckedRecentlyPanel filters on this
      action_type,      -- AdminErrorNotification filters on this
      asin,
      sku,
      marketplace,
      trigger_source,
      old_price,
      new_price,
      reason,
      success,
      error_message,
      error_type,
      rule_name,
      overlay_tag,
      created_at,
      update_method,
      assignment_id
    )
  $sql$;

  RAISE NOTICE 'repricer_price_actions realtime payload narrowed 52 -> 18 columns.';
END $$;

-- Assert the rest of the publication survived the DROP/ADD. If SET TABLE had
-- been used instead, this is the check that would have caught it.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'chat_messages', 'chat_sessions', 'automation_runs',
    'automation_results', 'fnsku_map', 'pl_sync_progress'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'publication lost tables during this migration: %', missing;
  END IF;
END $$;
