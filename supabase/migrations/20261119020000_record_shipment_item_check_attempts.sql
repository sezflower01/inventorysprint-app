-- Record the ATTEMPT, not only the result.
--
-- Amazon answers "this shipment has no items" with a 200 and 27 bytes -- a
-- real, cheap, final answer. Nothing wrote it down. The catch-up's skip cursor
-- is built from fba_shipment_items ROWS, so a shipment Amazon says is empty
-- was indistinguishable from one never asked about, and every run re-asked.
--
-- Measured on the 2026-11-19 01:21 run (run-tally):
--   item_fetches 136, item_rows_sent 120, item_fetch_failures 0
--   skipped_already_have 250, skipped_budget 105, shipments_found 491
-- Only 5 of 136 fetches returned items (24 each). The other 131 returned 27
-- bytes. At the 2 rps inbound_api gate that is ~65s of a 70s item budget spent
-- re-learning the same nothing every run, which is what starved the 105
-- shipments that genuinely still needed fetching.
--
-- This is the same shape as "Shipped 0" meaning both "nothing received" and
-- "no record": one state answering two questions. The fix is to give the
-- second question its own storage.
--
-- Deliberately NOT a boolean. items_found_count = 0 says Amazon was asked and
-- said none; NULL says never asked; > 0 says it had items. A boolean
-- "items_empty" would have reintroduced the same ambiguity on its NULL.

alter table public.fba_shipments
  add column if not exists items_checked_at timestamptz,
  add column if not exists items_found_count integer;

comment on column public.fba_shipments.items_checked_at is
  'When the SP-API inbound items endpoint was last asked about this shipment. NULL means never asked -- which is NOT the same as asked and told none (see items_found_count = 0). Stamped only on a definitive answer, never after an error, so a failed fetch retries.';

comment on column public.fba_shipments.items_found_count is
  'How many item lines that answer contained. 0 means Amazon was asked and reported none (the 27-byte 200). NULL means never asked. Used to skip re-fetching known-empty shipments without making "empty" and "unknown" the same state.';

-- Only the known-empty rows are ever scanned by the skip cursor.
create index if not exists idx_fba_shipments_items_checked_empty
  on public.fba_shipments (user_id, items_checked_at)
  where items_found_count = 0;

-- One-time backfill so the two signals agree from the start: a shipment that
-- already holds item rows was plainly asked at some point, and we know what it
-- answered. Uses the newest item row as the check time rather than now(), so
-- the staleness rule reads a real age. Idempotent -- only fills NULLs.
with counted as (
  select i.user_id, i.shipment_id,
         count(*)::int as line_count,
         max(coalesce(i.updated_at, i.created_at)) as last_seen
  from public.fba_shipment_items i
  group by i.user_id, i.shipment_id
)
update public.fba_shipments sh
set items_checked_at = counted.last_seen,
    items_found_count = counted.line_count
from counted
where counted.user_id = sh.user_id
  and counted.shipment_id = sh.shipment_id
  and sh.items_checked_at is null;

-- NOTE: shipments with no rows are left NULL on purpose. "Never asked" is the
-- honest answer for them, and the next run will ask and stamp. Backfilling
-- them as 0 would mark the entire October backlog as known-empty and freeze
-- the very gap this work closed.
