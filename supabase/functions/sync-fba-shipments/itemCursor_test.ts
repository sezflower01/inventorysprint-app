import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { collectShipmentsWithItems, type PageFetcher, type CursorRow } from './itemCursor.ts';

/**
 * A fake PostgREST that enforces the real `db-max-rows` cap: it never returns
 * more than `cap` rows however many are requested, and it orders by
 * shipment_id so paging is deterministic -- exactly the two properties the
 * production read was missing.
 */
function fakeTable(itemsPerShipment: Map<string, number>, cap = 1000) {
  const fetchPage: PageFetcher<CursorRow> = (chunk, offset, limit) => {
    const all: Array<{ shipment_id: string }> = [];
    for (const id of [...chunk].sort()) {
      const n = itemsPerShipment.get(id) ?? 0;
      for (let k = 0; k < n; k++) all.push({ shipment_id: id });
    }
    const slice = all.slice(offset, offset + Math.min(limit, cap));
    return Promise.resolve({ rows: slice });
  };
  return { fetchPage };
}

function shipments(count: number, itemsEach: number) {
  const m = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    m.set(`FBA${String(i).padStart(6, '0')}`, itemsEach);
  }
  return m;
}

Deno.test('REGRESSION: 150 shipments x 12 items exceeds the cap and all are still found', async () => {
  // The exact shape of the 2026-11-19 defect: ~1,800 rows, 1,000-row cap.
  const table = shipments(150, 12);
  const { fetchPage } = fakeTable(table);
  const out = await collectShipmentsWithItems([...table.keys()], fetchPage, { chunk: 150, page: 1000 });
  assertEquals(out.haveItemsFor.size, 150, 'every shipment with items must be found');
  assertEquals(out.rowsRead, 1800);
  assert(out.pages >= 2, 'more than one page was required');
  assertEquals(out.degraded, false);
});

Deno.test('the single-shot read it replaced would have under-reported', async () => {
  // Same table, but asking once: this is what the old code did, and it is why
  // the cursor reported 136 of 487 in-window shipments.
  const table = shipments(150, 12);
  const { fetchPage } = fakeTable(table);
  const onePage = await fetchPage([...table.keys()], 0, 1000);
  const found = new Set((onePage.rows ?? []).map((r) => r.shipment_id));
  assertEquals(onePage.rows?.length, 1000, 'the cap truncated the read');
  assert(found.size < 150, `a capped single read saw only ${found.size} of 150 shipments`);
  assertEquals(found.size, 84);
});

Deno.test('one shipment with more items than the cap is still found', async () => {
  // Why shrinking the chunk size is not the fix.
  const table = new Map([['FBA_HUGE', 2500]]);
  const { fetchPage } = fakeTable(table);
  const out = await collectShipmentsWithItems(['FBA_HUGE'], fetchPage, { chunk: 1, page: 1000 });
  assertEquals(out.haveItemsFor.size, 1);
  assertEquals(out.rowsRead, 2500);
  assertEquals(out.degraded, false);
});

Deno.test('shipments with no items are reported as not having items', async () => {
  const table = shipments(10, 3);
  const ids = [...table.keys(), 'FBA_EMPTY_1', 'FBA_EMPTY_2'];
  const { fetchPage } = fakeTable(table);
  const out = await collectShipmentsWithItems(ids, fetchPage, { chunk: 150, page: 1000 });
  assertEquals(out.haveItemsFor.size, 10);
  assert(!out.haveItemsFor.has('FBA_EMPTY_1'));
  assertEquals(out.degraded, false);
});

Deno.test('a failed page marks the cursor degraded instead of empty', async () => {
  const notes: string[] = [];
  const out = await collectShipmentsWithItems(
    ['A', 'B'],
    () => Promise.resolve({ rows: null, error: 'connection reset' }),
    { chunk: 150, page: 1000, onNote: (n) => notes.push(n) },
  );
  assertEquals(out.degraded, true, 'a broken cursor must never look like an empty one');
  assertEquals(out.haveItemsFor.size, 0);
  assert(notes[0].includes('connection reset'));
});

Deno.test('chunk size changes cost, never the answer', async () => {
  const table = shipments(400, 7);
  const ids = [...table.keys()];
  for (const chunk of [1, 25, 150, 400]) {
    const { fetchPage } = fakeTable(table);
    const out = await collectShipmentsWithItems(ids, fetchPage, { chunk, page: 1000 });
    assertEquals(out.degraded, false);
    assertEquals(out.haveItemsFor.size, 400, `chunk ${chunk} must still find all 400`);
  }
});

Deno.test('a page that returns exactly the page size is not treated as the end', async () => {
  // 2000 rows over 2 shipments: page 1 is exactly full and must not terminate.
  const table = new Map([['A', 1000], ['B', 1000]]);
  const { fetchPage } = fakeTable(table);
  const out = await collectShipmentsWithItems(['A', 'B'], fetchPage, { chunk: 150, page: 1000 });
  assertEquals(out.haveItemsFor.size, 2, 'the second shipment lived entirely past the page boundary');
  assertEquals(out.rowsRead, 2000);
});

Deno.test('the runaway guard bounds a server that always returns a full page', async () => {
  const fetchPage: PageFetcher<CursorRow> = (_chunk, _offset, limit) =>
    Promise.resolve({ rows: Array.from({ length: limit }, () => ({ shipment_id: 'A' })) });
  const out = await collectShipmentsWithItems(['A'], fetchPage, {
    chunk: 150,
    page: 1000,
    maxRowsPerChunk: 5000,
  });
  assertEquals(out.degraded, true);
  assert(out.rowsRead <= 6000, `guard must bound the read, got ${out.rowsRead}`);
});
