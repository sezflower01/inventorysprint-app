// WHAT THIS RUN CAN SKIP -- two questions, deliberately kept separate.
//
//   1. Which shipments already HOLD item rows?          (collectShipmentsWithItems)
//   2. Which were ASKED and told "none"?                (collectKnownEmptyShipments)
//
// Collapsing those two was the defect. The skip cursor read only question 1,
// so a shipment Amazon answers with a 27-byte "no items" 200 looked exactly
// like one that had never been asked, and every catch-up run asked again.
// Measured on the 2026-11-19 01:21 run: 131 of 136 fetches returned 27 bytes,
// which at the 2 rps inbound_api gate is ~65s of a 70s item budget spent
// re-learning the same nothing -- starving the 105 shipments that still needed
// fetching. Question 2 now has its own storage (fba_shipments.items_checked_at
// / items_found_count, migration 20261119020000).
//
// Both reads share `pageChunked` because of the OTHER defect, twice over:
//
//   - `.limit(50000)` on the item table returned ~1,000 rows with no error.
//     The cursor built from it saw 122 of 1,163 shipments.
//   - Its replacement scoped the read to a bounded key set -- 150 shipment IDs
//     per `.in()` -- and was STILL capped, because it selected ITEM rows,
//     ~12 per shipment, so ~1,800 against the 1,000-row ceiling with no
//     ORDER BY. It reported 136 of 487 and the run re-fetched ~106 shipments
//     it already held: 1,389 rows sent, 135 created.
//
// Bounding the KEYS does not bound the ROWS. A single shipment can carry
// hundreds of items, so no chunk size is small enough to be safe -- only
// paging is. A FULL PAGE IS NEVER EVIDENCE THAT THE DATA ENDED. Only a short
// page is.
//
// Kept function-local rather than in _shared/**, because a shared-module edit
// redeploys every one of the ~262 edge functions.

export interface PageResult<T> {
  /** null signals a failed read; [] signals a genuinely empty page. */
  rows: T[] | null;
  error?: string;
}

/** Fetches one page. `limit` is a request, never a guarantee. */
export type PageFetcher<T> = (
  chunk: string[],
  offset: number,
  limit: number,
) => Promise<PageResult<T>>;

export interface PageOptions {
  /** IDs per `.in()` filter. Correctness does not depend on this; cost does. */
  chunk?: number;
  /** Rows requested per page. Must not exceed the server cap or paging stalls. */
  page?: number;
  /** Runaway guard per chunk. */
  maxRowsPerChunk?: number;
  onNote?: (note: string) => void;
}

export interface PageOutcome<T> {
  rows: T[];
  pages: number;
  rowsRead: number;
  /**
   * True if any page failed or a guard tripped. The caller MUST treat a
   * degraded read as incomplete rather than as "nothing matched" -- an empty
   * skip set means "fetch everything" and would burn the whole budget.
   */
  degraded: boolean;
}

/**
 * Reads every row matching a bounded key set, in ID chunks, paging each chunk
 * until a page comes back SHORT. Deterministic only because the caller orders
 * the query; an unordered capped page is arbitrary heap order and paging past
 * it can return rows it already showed.
 */
export async function pageChunked<T>(
  ids: string[],
  fetchPage: PageFetcher<T>,
  opts: PageOptions = {},
): Promise<PageOutcome<T>> {
  const chunkSize = opts.chunk ?? 150;
  const pageSize = opts.page ?? 1000;
  const maxRowsPerChunk = opts.maxRowsPerChunk ?? 200_000;
  const note = opts.onNote ?? (() => {});

  const rows: T[] = [];
  let pages = 0;
  let rowsRead = 0;
  let degraded = false;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let offset = 0;
    for (;;) {
      const page = await fetchPage(chunk, offset, pageSize);
      pages++;
      if (page.rows === null) {
        note(`chunk at ${i} page ${pages} failed: ${page.error ?? 'unknown error'}`);
        degraded = true;
        break;
      }
      rowsRead += page.rows.length;
      for (const r of page.rows) rows.push(r);
      // The only proof the rows ran out.
      if (page.rows.length < pageSize) break;
      offset += page.rows.length;
      if (offset > maxRowsPerChunk) {
        note(`chunk at ${i} exceeded ${maxRowsPerChunk} rows, stopping`);
        degraded = true;
        break;
      }
    }
  }

  return { rows, pages, rowsRead, degraded };
}

export interface CursorRow {
  shipment_id?: string | null;
}

export interface CursorOutcome {
  haveItemsFor: Set<string>;
  pages: number;
  rowsRead: number;
  degraded: boolean;
}

/** Question 1: which of these shipments already hold item rows? */
export async function collectShipmentsWithItems(
  ids: string[],
  fetchPage: PageFetcher<CursorRow>,
  opts: PageOptions = {},
): Promise<CursorOutcome> {
  const out = await pageChunked(ids, fetchPage, opts);
  const haveItemsFor = new Set<string>();
  for (const r of out.rows) {
    if (r?.shipment_id) haveItemsFor.add(String(r.shipment_id));
  }
  return {
    haveItemsFor,
    pages: out.pages,
    rowsRead: out.rowsRead,
    degraded: out.degraded,
  };
}

// --------------------------------------------------------------- known empty

/**
 * A terminal shipment's contents cannot change, so "Amazon has no items for
 * it" stays true and only needs an occasional re-check against our own write
 * bugs. An ACTIVE one legitimately has no items YET, so it must be re-asked
 * soon or a shipment created minutes ago would be written off.
 */
export const TERMINAL_RECHECK_DAYS = 30;
export const ACTIVE_RECHECK_DAYS = 1;

const TERMINAL_STATUSES = new Set([
  'CLOSED',
  'CANCELLED',
  'DELETED',
  'ERROR',
  'RECEIVED',
]);

export interface ShipmentCheckRow {
  shipment_id?: string | null;
  shipment_status?: string | null;
  items_checked_at?: string | null;
  items_found_count?: number | null;
}

export function recheckWindowDays(status: string | null | undefined): number {
  const s = (status ?? '').trim().toUpperCase();
  return TERMINAL_STATUSES.has(s) ? TERMINAL_RECHECK_DAYS : ACTIVE_RECHECK_DAYS;
}

/**
 * True only for "we asked, Amazon said none, and that answer is still fresh".
 *
 * Every other state returns false, which costs a fetch. That asymmetry is
 * deliberate: a wrong `true` silently keeps a gap open on the page that
 * decides whether to chase a supplier for money, while a wrong `false` costs
 * one ~50ms call.
 */
export function isKnownEmpty(row: ShipmentCheckRow, nowMs: number): boolean {
  // NULL means never asked. Only an explicit 0 means asked and told none.
  if (row.items_found_count !== 0) return false;
  if (!row.items_checked_at) return false;
  const checkedMs = Date.parse(String(row.items_checked_at));
  if (!Number.isFinite(checkedMs)) return false;
  // A stamp in the future is a clock or data problem, not a fresh check.
  if (checkedMs > nowMs) return false;
  const ageDays = (nowMs - checkedMs) / 86_400_000;
  return ageDays < recheckWindowDays(row.shipment_status);
}

export interface KnownEmptyOutcome {
  knownEmpty: Set<string>;
  checkedAndEmpty: number;
  staleEmpty: number;
  pages: number;
  rowsRead: number;
  degraded: boolean;
}

/** Question 2: which were asked recently and reported no items? */
export async function collectKnownEmptyShipments(
  ids: string[],
  fetchPage: PageFetcher<ShipmentCheckRow>,
  nowMs: number,
  opts: PageOptions = {},
): Promise<KnownEmptyOutcome> {
  const out = await pageChunked(ids, fetchPage, opts);
  const knownEmpty = new Set<string>();
  let checkedAndEmpty = 0;
  let staleEmpty = 0;
  for (const r of out.rows) {
    if (!r?.shipment_id) continue;
    if (r.items_found_count !== 0) continue;
    checkedAndEmpty++;
    if (isKnownEmpty(r, nowMs)) knownEmpty.add(String(r.shipment_id));
    else staleEmpty++;
  }
  return {
    knownEmpty,
    checkedAndEmpty,
    staleEmpty,
    pages: out.pages,
    rowsRead: out.rowsRead,
    degraded: out.degraded,
  };
}
