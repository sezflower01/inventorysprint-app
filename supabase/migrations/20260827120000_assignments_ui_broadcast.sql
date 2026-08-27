-- Column-gated broadcast for the four repricer_assignments columns the UI reads.
--
-- ── THE PROBLEM ───────────────────────────────────────────────────────────
--
-- repricer_assignments is in the supabase_realtime publication, is 185 columns
-- wide, and takes ~9.2 UPDATEs/second of machine bookkeeping from
-- repricer-scheduler. Realtime broadcasts on ANY row change regardless of
-- which column moved, so every one of those decoded and shipped a 185-column
-- row to every subscribed tab.
--
-- Measured 2026-08-20 over a 51.28h pg_stat_statements window:
--   repricer_assignments UPDATE calls   1,704,493   (~9.2/second)
--   realtime.list_changes calls           717,900
--   realtime buffers touched           32,481 GB
--   realtime exec time                 31,370 s     (8.7 hours of CPU)
-- realtime.list_changes was 93% of the top-15 queries by buffers touched,
-- 14x the next entry, against ~290 GB/month of billed database egress.
--
-- 20260820170000_move_check_counter_off_hot_table.sql removed 17.4% of those
-- writes. This migration goes after the other 82.6% by changing the transport
-- rather than the write rate.
--
-- ── WHAT THE SUBSCRIBERS ACTUALLY READ ────────────────────────────────────
--
-- Audited 2026-08-27. Exactly two sites in src/ subscribed to this table:
--
--   AssignmentsTable.tsx   reads id, ui_edit_locked, min_price_override,
--                          max_price_override, manual_min_price  -- and nothing else
--   ActionLogDialog.tsx    ignores the payload entirely; calls fetchData()
--
-- All four meaningful columns are HUMAN actions: clicking the padlock, typing
-- a price on another computer. They change a few times an hour. None of them
-- is ever touched by the hot bookkeeping path (last_ack_result,
-- last_sp_api_check_at, last_buybox_status, no_bb_progress_streak,
-- buybox_lost_at, bb_recovery_escalation, bb_loss_after_raise_count,
-- restock_reentry_at, delta_too_small_streak). The overlap is zero, not small.
--
-- ActionLogDialog is handled separately -- it moved to a bounded poll while
-- the dialog is open, because it genuinely wanted the bookkeeping columns and
-- routing those through a trigger would put 9.2 inserts/second into
-- realtime.messages, which is a real table write and therefore worse than the
-- WAL decode it replaced.
--
-- ── WHY A TRIGGER AND NOT A PUBLICATION FILTER ────────────────────────────
--
-- Postgres publication row filters (ALTER PUBLICATION ... WHERE) can only
-- reference the new row, so they cannot express "this column changed".
-- Publication COLUMN lists shrink the payload but the event still fires on
-- every UPDATE. A trigger WHEN clause is the only mechanism that suppresses
-- the event itself, and it is evaluated before the trigger function is called,
-- so a bookkeeping write costs four IS DISTINCT FROM comparisons and stops.
--
-- Note the table has REPLICA IDENTITY DEFAULT (only automation_runs,
-- automation_results and fnsku_map were ever set to FULL). Under DEFAULT, a
-- logical-replication OLD tuple is just the primary key -- but inside a
-- trigger OLD is fully populated regardless, which is exactly why the WHEN
-- clause below works and a publication-level equivalent would not.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
--
-- This table is the repricer's hot path. A trigger that raises would abort the
-- UPDATE and stop repricing, so the function swallows every exception and
-- returns. Telemetry must never be able to fail the write it observes -- the
-- same rule bump_assignment_check_counter follows.
--
-- This migration is ADDITIVE. repricer_assignments stays in the publication
-- here; 20260827120002 removes it, after the broadcast path is confirmed. In
-- between, both transports deliver and the client handler is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Preconditions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION
      'realtime.send(jsonb,text,text,boolean) not found -- this Supabase instance predates Broadcast-from-Database. Do not apply the rest of this series.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Let each user read their own broadcast topic
-- ---------------------------------------------------------------------------
-- realtime.messages is the backing table for Broadcast-from-Database. A
-- private channel authorises its subscription against this policy, so without
-- it the client subscribes successfully and then simply never receives
-- anything -- a silent failure, which is why AssignmentsTable keeps the
-- postgres_changes transport alive until this is proven.
--
-- Topic is `assignment-ui-<user_id>`, matching the user-scoped naming contract
-- in docs/realtime-channels.md. The policy is what makes the scoping real
-- rather than conventional: a client that subscribes to someone else's topic
-- is denied by RLS, not merely by not guessing the name.
DROP POLICY IF EXISTS "assignment ui broadcast is own-user only" ON realtime.messages;
CREATE POLICY "assignment ui broadcast is own-user only"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    extension = 'broadcast'
    AND realtime.topic() = 'assignment-ui-' || auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 3. The broadcast function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_assignment_ui_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Five fields, not the whole row. realtime.broadcast_changes() would have
  -- been shorter, but it ships the entire NEW record -- all 185 columns -- and
  -- re-importing the original problem into the replacement would be a poor
  -- joke. The client reads exactly these keys.
  PERFORM realtime.send(
    jsonb_build_object(
      'id',                 NEW.id,
      'ui_edit_locked',     NEW.ui_edit_locked,
      'min_price_override', NEW.min_price_override,
      'max_price_override', NEW.max_price_override,
      'manual_min_price',   NEW.manual_min_price
    ),
    'assignment_ui',
    'assignment-ui-' || NEW.user_id::text,
    true            -- private: authorised by the policy above
  );
  RETURN NULL;      -- AFTER trigger; return value is ignored
EXCEPTION WHEN OTHERS THEN
  -- Never fail the UPDATE. A padlock that does not sync is an annoyance; a
  -- repricer that stops writing is an outage.
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_assignment_ui_change() FROM public;

-- ---------------------------------------------------------------------------
-- 4. The trigger
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_broadcast_assignment_ui ON public.repricer_assignments;
CREATE TRIGGER trg_broadcast_assignment_ui
  AFTER UPDATE ON public.repricer_assignments
  FOR EACH ROW
  WHEN (
       OLD.ui_edit_locked      IS DISTINCT FROM NEW.ui_edit_locked
    OR OLD.min_price_override  IS DISTINCT FROM NEW.min_price_override
    OR OLD.max_price_override  IS DISTINCT FROM NEW.max_price_override
    OR OLD.manual_min_price    IS DISTINCT FROM NEW.manual_min_price
  )
  EXECUTE FUNCTION public.broadcast_assignment_ui_change();

-- ---------------------------------------------------------------------------
-- 5. Assert what this migration assumed
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_trigger
  WHERE tgrelid = 'public.repricer_assignments'::regclass
    AND tgname = 'trg_broadcast_assignment_ui'
    AND NOT tgisinternal;
  IF n <> 1 THEN
    RAISE EXCEPTION 'trg_broadcast_assignment_ui did not install';
  END IF;

  -- Deliberately still published at this point. 20260827120002 is what flips
  -- the transport; if that one is skipped, this migration is a no-op cost of
  -- four comparisons per UPDATE and nothing breaks.
  SELECT count(*) INTO n
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename = 'repricer_assignments';
  RAISE NOTICE 'broadcast trigger installed; repricer_assignments still in publication (%). Apply 20260827120002 once broadcast is verified.', n;
END $$;
