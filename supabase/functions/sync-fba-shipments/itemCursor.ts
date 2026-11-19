// WHICH SHIPMENTS ALREADY HAVE ITEMS -- a read that must not under-report.
//
// This cursor decides which shipments the run can SKIP. Its failure mode is
// asymmetric and expensive:
//
//   - Over-report a shipment as "has items" and the run skips real work.
//   - Under-report one and the run spends an Amazon API slot re-fetching items
//     it already holds, then upserts them onto themselves.
//
// The second is what happened. Measured on 2026-11-19: the cursor asked for
// 150 shipment IDs per chunk but selected ITEM rows, ~12 per shipment, so
// ~1,800 rows against PostgREST's 1,000-row `db-max-rows` cap -- with no
// ORDER BY, so which ~83 shipments survived was arbitrary heap order. It
// reported 136 of 487 in-window shipments. The run then re-fetched ~106
// already-complete shipments, sent 1,389 item rows, and created 135 new ones.
// Net progress for a full 80s run against a 2 rps quota: 14 shipments. At that
// rate a 351-shipment backlog needs ~25 runs instead of ~3.
//
// This is the third appearance of one cap in this file's history: a
// `.limit(50000)` that was never granted, a chunked read that paged nothing,
// and the same lesson both times -- A FULL PAGE IS NOT EVIDENCE THAT THE DATA
// ENDED. Only a short page is. A smaller chunk size would have made the cap
// rarer, never absent: one shipment can carry hundreds of items.
//
// Kept function-local rather than in _shared/**, because a shared-module edit
// redeploys every one of the ~262 edge functions.

export interface CursorRow {
  shipment_id?: string | null;
}

export interface CursorPageResult {
  /** null signals a failed read; [] signals a genuinely empty page. */
  rows: CursorRow[] | null;
  error?: string;
}

/** Fetches one page. `limit` is a request, never a guarantee -- the server may return fewer. */
export type CursorPageFetcher = (
  chunk: string[],
  offset: number,
  limit: number,
) => Promise<CursorPageResult>;

export interface CursorOptions {
  /** IDs per `.in()` filter. Correctness does not depend on this; cost does. */
  chunk?: number;
  /** Rows requested per page. Must not exceed the server cap or paging stalls. */
  page?: number;
  /** Runaway guard per chunk. */
  maxRowsPerChunk?: number;
  onNote?: (note: string) => void;
}

export interface CursorOutcome {
  haveItemsFor: Set<string>;
  pages: number;
  rowsRead: number;
  /**
   * True if any page failed or a guard tripped. The caller MUST treat a
   * degraded cursor as incomplete rather than as "nothing has items" -- an
   * empty cursor means "fetch everything" and would burn the whole budget.
   */
  degraded: boolean;
}

export async function collectShipmentsWithItems(
  ids: string[],
  fetchPage: CursorPageFetcher,
  opts: CursorOptions = {},
): Promise<CursorOutcome> {
  const chunkSize = opts.chunk ?? 150;
  const pageSize = opts.page ?? 1000;
  const maxRowsPerChunk = opts.maxRowsPerChunk ?? 200_000;
  const note = opts.onNote ?? (() => {});

  const haveItemsFor = new Set<string>();
  let pages = 0;
  let rowsRead = 0;
  let degraded = false;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let offset = 0;
    for (;;) {
      const { rows, error } = await fetchPage(chunk, offset, pageSize);
      pages++;
      if (rows === null) {
        note(`chunk at ${i} page ${pages} failed: ${error ?? 'unknown error'}`);
        degraded = true;
        break;
      }
      rowsRead += rows.length;
      for (const r of rows) {
        if (r?.shipment_id) haveItemsFor.add(String(r.shipment_id));
      }
      // The only proof the rows ran out.
      if (rows.length < pageSize) break;
      offset += rows.length;
      if (offset > maxRowsPerChunk) {
        note(`chunk at ${i} exceeded ${maxRowsPerChunk} rows, stopping`);
        degraded = true;
        break;
      }
    }
  }

  return { haveItemsFor, pages, rowsRead, degraded };
}
