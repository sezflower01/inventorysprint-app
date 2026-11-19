import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  ACTIVE_RECHECK_DAYS,
  collectKnownEmptyShipments,
  isKnownEmpty,
  recheckWindowDays,
  TERMINAL_RECHECK_DAYS,
  type PageFetcher,
  type ShipmentCheckRow,
} from './itemCursor.ts';

const NOW = Date.parse('2026-11-19T02:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

Deno.test('THE DEFECT: never-asked and asked-and-empty are different states', () => {
  // This is the whole point of the column pair. Before it, both of these rows
  // looked identical to the cursor -- a shipment with no item rows -- so the
  // 131 that Amazon answers with a 27-byte 200 were re-asked every run.
  const neverAsked: ShipmentCheckRow = {
    shipment_id: 'FBA_NEVER',
    shipment_status: 'CLOSED',
    items_checked_at: null,
    items_found_count: null,
  };
  const askedAndEmpty: ShipmentCheckRow = {
    shipment_id: 'FBA17TFL9VYF',
    shipment_status: 'CLOSED',
    items_checked_at: daysAgo(1),
    items_found_count: 0,
  };
  assertEquals(isKnownEmpty(neverAsked, NOW), false, 'never asked must still be asked');
  assertEquals(isKnownEmpty(askedAndEmpty, NOW), true, 'asked and told none must be skipped');
});

Deno.test('a shipment that HAS items is not treated as known-empty', () => {
  // It is skipped by the item-rows cursor instead; this function must not also
  // claim it, or a single wrong count would hide a real shipment.
  assertEquals(
    isKnownEmpty({ shipment_id: 'A', shipment_status: 'CLOSED', items_checked_at: daysAgo(1), items_found_count: 12 }, NOW),
    false,
  );
});

Deno.test('an ACTIVE shipment with no items yet is re-asked the next day', () => {
  const row = (ageDays: number): ShipmentCheckRow => ({
    shipment_id: 'FBA_WORKING',
    shipment_status: 'WORKING',
    items_checked_at: daysAgo(ageDays),
    items_found_count: 0,
  });
  // A shipment created minutes ago legitimately has no items. Skipping it for
  // 30 days would write off a live shipment.
  assertEquals(recheckWindowDays('WORKING'), ACTIVE_RECHECK_DAYS);
  assertEquals(isKnownEmpty(row(0.2), NOW), true, 'fresh enough to trust for now');
  assertEquals(isKnownEmpty(row(1.5), NOW), false, 'must be re-asked after a day');
});

Deno.test('a terminal shipment is trusted for 30 days, not forever', () => {
  const row = (ageDays: number): ShipmentCheckRow => ({
    shipment_id: 'FBA_CLOSED',
    shipment_status: 'CLOSED',
    items_checked_at: daysAgo(ageDays),
    items_found_count: 0,
  });
  assertEquals(recheckWindowDays('CLOSED'), TERMINAL_RECHECK_DAYS);
  assertEquals(isKnownEmpty(row(29), NOW), true);
  assertEquals(isKnownEmpty(row(31), NOW), false, 'never permanent -- re-checks catch our own write bugs');
});

Deno.test('status matching ignores case and padding', () => {
  for (const s of ['closed', ' Closed ', 'CLOSED']) {
    assertEquals(recheckWindowDays(s), TERMINAL_RECHECK_DAYS, `status ${JSON.stringify(s)}`);
  }
  // An unknown or missing status gets the SHORT window: erring toward asking.
  for (const s of [null, undefined, '', 'SOMETHING_NEW']) {
    assertEquals(recheckWindowDays(s), ACTIVE_RECHECK_DAYS, `status ${JSON.stringify(s)}`);
  }
});

Deno.test('an unusable or future stamp means ask again', () => {
  const base = { shipment_id: 'A', shipment_status: 'CLOSED', items_found_count: 0 };
  for (const stamp of [null, undefined, '', 'not a date', 'yesterday']) {
    assertEquals(
      isKnownEmpty({ ...base, items_checked_at: stamp as string | null }, NOW),
      false,
      `stamp ${JSON.stringify(stamp)} must not count as a check`,
    );
  }
  const future = new Date(NOW + 86_400_000).toISOString();
  assertEquals(
    isKnownEmpty({ ...base, items_checked_at: future }, NOW),
    false,
    'a future stamp is a clock or data problem, not a fresh check',
  );
});

Deno.test('INVARIANT: only an explicit zero count can ever be skipped', () => {
  for (const count of [null, undefined, -1, 1, 12, 0.5]) {
    assertEquals(
      isKnownEmpty(
        { shipment_id: 'A', shipment_status: 'CLOSED', items_checked_at: daysAgo(1), items_found_count: count as number | null },
        NOW,
      ),
      false,
      `count ${JSON.stringify(count)} must not be skippable`,
    );
  }
});

Deno.test('collectKnownEmptyShipments separates fresh from stale', async () => {
  const rows: ShipmentCheckRow[] = [
    { shipment_id: 'FRESH_CLOSED', shipment_status: 'CLOSED', items_checked_at: daysAgo(2), items_found_count: 0 },
    { shipment_id: 'STALE_CLOSED', shipment_status: 'CLOSED', items_checked_at: daysAgo(40), items_found_count: 0 },
    { shipment_id: 'FRESH_WORKING', shipment_status: 'WORKING', items_checked_at: daysAgo(0.1), items_found_count: 0 },
    { shipment_id: 'STALE_WORKING', shipment_status: 'WORKING', items_checked_at: daysAgo(3), items_found_count: 0 },
    { shipment_id: 'HAS_ITEMS', shipment_status: 'CLOSED', items_checked_at: daysAgo(1), items_found_count: 9 },
    { shipment_id: 'NEVER_ASKED', shipment_status: 'CLOSED', items_checked_at: null, items_found_count: null },
  ];
  const fetchPage: PageFetcher<ShipmentCheckRow> = (_chunk, offset, limit) =>
    Promise.resolve({ rows: rows.slice(offset, offset + limit) });

  const out = await collectKnownEmptyShipments(rows.map((r) => String(r.shipment_id)), fetchPage, NOW);
  assertEquals([...out.knownEmpty].sort(), ['FRESH_CLOSED', 'FRESH_WORKING']);
  assertEquals(out.checkedAndEmpty, 4, 'four rows were asked and reported none');
  assertEquals(out.staleEmpty, 2, 'two of those answers aged out');
  assertEquals(out.degraded, false);
});

Deno.test('a failed read yields an EMPTY skip set and says it is degraded', async () => {
  // An empty skip set means "fetch everything", which is expensive but safe.
  // Silently claiming shipments are empty would not be.
  const notes: string[] = [];
  const out = await collectKnownEmptyShipments(
    ['A', 'B'],
    () => Promise.resolve({ rows: null, error: 'statement timeout' }),
    NOW,
    { onNote: (n) => notes.push(n) },
  );
  assertEquals(out.knownEmpty.size, 0);
  assertEquals(out.degraded, true);
  assert(notes[0].includes('statement timeout'));
});

Deno.test('the known-empty read is paged, so it cannot be capped either', async () => {
  // 2,400 shipment rows: one row per shipment, but still more than the
  // 1,000-row cap, and this read has the same ceiling as the item read.
  const all: ShipmentCheckRow[] = Array.from({ length: 2400 }, (_, i) => ({
    shipment_id: `FBA${String(i).padStart(6, '0')}`,
    shipment_status: 'CLOSED',
    items_checked_at: daysAgo(1),
    items_found_count: 0,
  }));
  const CAP = 1000;
  const fetchPage: PageFetcher<ShipmentCheckRow> = (chunk, offset, limit) => {
    const inChunk = all.filter((r) => chunk.includes(String(r.shipment_id)));
    return Promise.resolve({ rows: inChunk.slice(offset, offset + Math.min(limit, CAP)) });
  };
  const out = await collectKnownEmptyShipments(
    all.map((r) => String(r.shipment_id)),
    fetchPage,
    NOW,
    { chunk: 2400, page: 1000 },
  );
  assertEquals(out.knownEmpty.size, 2400, 'every known-empty shipment must be found');
  assertEquals(out.rowsRead, 2400);
  assert(out.pages >= 3);
});
