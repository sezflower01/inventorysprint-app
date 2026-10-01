-- Make the override sources the triggers demand actually legal.
--
-- Two guards on public.inventory contradict each other, and the result is that
-- a ghosted listing can NEVER come back:
--
--   fn_protect_ghost_tombstone (BEFORE UPDATE) reverts any change of
--   listing_status away from NOT_IN_CATALOG / DELETED unless the same write
--   sets source = 'force_relist'. That is its documented escape hatch.
--
--   inventory_source_check (CHECK) permits only
--     manual, amazon_sync, amazon_sync_fbm, preserved_db, history_restore, live_api
--   so a write that sets source = 'force_relist' is REJECTED outright.
--
-- The hatch is therefore unreachable: the only write the trigger would accept
-- is the only write the constraint forbids. Proved on B09PJPB34P (2026-10-01):
--   UPDATE inventory SET source = 'force_relist' ...
--   ERROR 23514: violates check constraint "inventory_source_check"
-- while a write without it silently kept NOT_IN_CATALOG -- the trigger saves
-- every other column in the statement and reverts only listing_status, with the
-- refusal going to the Postgres log. So the listing looked updated, the ghost
-- stamp really did clear, and the status never moved.
--
-- Cost of this contradiction, measured the same day: 402 inventory rows sit in
-- a terminal status, 69 of them with an ENABLED repricer assignment and 473
-- units of stock between them. Those rows are hidden from the repricer
-- (AssignmentsTable drops NOT_IN_CATALOG outright) and excluded from every
-- sweep that could have re-checked them (bulk-live-verify and fbm-quick-check
-- both filter them out), so a listing recreated on Amazon stays invisible
-- indefinitely. B09PJPB34P is live and BUYABLE on Amazon right now and has been
-- missing from the repricer since 2026-05-20.
--
-- fn_inventory_freshness_guard names two more overrides the constraint also
-- rejects -- 'manual_override' and 'amazon_sync_accept' -- so those hatches are
-- just as dead. All three are added here: a constraint that forbids the values
-- live trigger code asks for is the stale half of the disagreement.
--
-- Deliberately NOT done: weakening fn_protect_ghost_tombstone to accept an
-- ordinary source like 'live_api'. The tombstone is there so a routine sync
-- cannot resurrect a dead listing by accident, and that is worth keeping --
-- resurrection should stay an explicit, named act.

ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_source_check;

ALTER TABLE public.inventory ADD CONSTRAINT inventory_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'amazon_sync'::text,
    'amazon_sync_fbm'::text,
    'preserved_db'::text,
    'history_restore'::text,
    'live_api'::text,
    -- required by fn_protect_ghost_tombstone to lift a terminal status
    'force_relist'::text,
    -- both required by fn_inventory_freshness_guard to bypass the watermark
    'manual_override'::text,
    'amazon_sync_accept'::text
  ]));

COMMENT ON CONSTRAINT inventory_source_check ON public.inventory IS
  'Allowed inventory.source values. Must stay in step with the override sources named in fn_protect_ghost_tombstone and fn_inventory_freshness_guard -- omitting one makes that trigger''s escape hatch unreachable, which silently froze 402 rows in NOT_IN_CATALOG until 2026-10-01.';
