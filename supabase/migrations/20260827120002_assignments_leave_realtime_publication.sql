-- Remove repricer_assignments from the supabase_realtime publication.
--
-- ⚠️ DO NOT APPLY THIS UNTIL THE BROADCAST PATH IS VERIFIED. ⚠️
--
-- This is the migration that actually collects the win, and it is also the
-- only one in the series that can break a working feature. Ordering matters:
--
--   1. Deploy the frontend (AssignmentsTable dual-transport, ActionLogDialog
--      poll). Vercel does this automatically on push to main.
--   2. Apply 20260827120000 -- installs the WHEN-gated broadcast trigger.
--      Additive; both transports now deliver.
--   3. Confirm padlock sync works. Open the Repricer on two machines as the
--      same user, toggle a padlock on one, watch it move on the other. That
--      proves broadcast specifically ONLY if you can attribute it -- see the
--      verification note below.
--   4. Apply this migration.
--
-- Reverting is one statement and takes effect immediately:
--
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.repricer_assignments;
--
-- ── HOW TO ACTUALLY VERIFY STEP 3 ─────────────────────────────────────────
--
-- Until this migration runs, BOTH transports deliver, so a working padlock
-- proves nothing about broadcast -- postgres_changes alone would produce the
-- identical result. That is the trap. Verify the broadcast path directly
-- instead, by confirming rows are landing in realtime.messages:
--
--   SELECT topic, event, inserted_at
--   FROM realtime.messages
--   WHERE topic LIKE 'assignment-ui-%'
--   ORDER BY inserted_at DESC
--   LIMIT 20;
--
-- Toggle a padlock, re-run, and confirm a new row appeared with your user id
-- in the topic. If that table stays empty, the trigger is not firing or
-- realtime.send is failing silently inside the exception handler -- do NOT
-- apply this migration, and check the trigger's WHEN clause against what the
-- UI actually wrote.
--
-- realtime.messages is partitioned and retained for a few days, so an empty
-- result on an idle account is not evidence of failure. Toggle first, then
-- look.
--
-- ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
--
-- It does not stop any writes. repricer-scheduler keeps updating
-- repricer_assignments ~9.2 times a second exactly as before; those writes
-- simply stop being decoded, RLS-filtered and fanned out to every subscribed
-- tab. Expect the write volume in pg_stat_statements to be unchanged and
-- realtime.list_changes to collapse. If UPDATE volume drops too, something
-- else changed and it is not this migration.

DO $$
DECLARE
  trg_ok boolean;
BEGIN
  -- Refuse to run if the replacement is not in place. Removing the table from
  -- the publication without the trigger installed would silently kill padlock
  -- and cross-computer price sync with nothing to take over.
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.repricer_assignments'::regclass
      AND tgname = 'trg_broadcast_assignment_ui'
      AND NOT tgisinternal
  ) INTO trg_ok;

  IF NOT trg_ok THEN
    RAISE EXCEPTION
      'trg_broadcast_assignment_ui is missing -- apply 20260827120000_assignments_ui_broadcast.sql first. Refusing to remove the table from realtime with no replacement transport.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'repricer_assignments'
  ) THEN
    -- DROP TABLE, not SET TABLE. SET TABLE would replace the publication's
    -- entire table list and take chat, automation and pl_sync_progress out of
    -- realtime as collateral. See 20260827120001 for the same trap.
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.repricer_assignments';
    RAISE NOTICE 'repricer_assignments removed from supabase_realtime. UI events now come from trg_broadcast_assignment_ui only.';
  ELSE
    RAISE NOTICE 'repricer_assignments was already absent from supabase_realtime -- nothing to do.';
  END IF;
END $$;

-- Same guard as the sibling migration: prove nothing else fell out.
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
