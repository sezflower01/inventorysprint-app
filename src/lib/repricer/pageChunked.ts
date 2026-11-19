/**
 * Read every row for a set of keys, in chunks, paging within each chunk.
 *
 * THE RULE THIS EXISTS TO ENFORCE
 *
 * Bounding the KEY SET does not bound the ROWS. Splitting 2,500 ASINs into
 * chunks of 500 keeps the URL short; it says nothing about how many rows come
 * back, because most tables here hold many rows per ASIN. PostgREST then
 * clamps every response to db-max-rows (1,000 on this project) regardless of
 * what `.limit()` asks for, so a single request per chunk can come back
 * exactly full, look complete, and have silently dropped the rest.
 *
 * A FULL PAGE IS NEVER EVIDENCE THE ROWS RAN OUT. Only a short page is.
 *
 * This repo has now hit that in six places -- a shipment-items cursor twice,
 * an enrichment read, a set-returning RPC, the created_listings enrichment,
 * and the chunked helper that fed four more reads. Each time it was found by
 * noticing a suspiciously round number, never by an error. So the loop lives
 * here, with tests, instead of being written again at each call site.
 *
 * Transport-agnostic on purpose: the caller supplies a fetcher, so a test can
 * supply a fake table that enforces the same 1,000-row cap the real one does.
 */

/** This project's PostgREST db-max-rows. A client can lower it, never raise it. */
export const POSTGREST_PAGE_SIZE = 1000;

/** Keys per request. URL-length management only -- it bounds nothing else. */
export const DEFAULT_CHUNK_SIZE = 500;

/**
 * Runaway guard, not a cap on truth. 20 pages for a 500-key chunk is already
 * 40 rows per key; past that the query is wrong, not the data, and looping
 * forever would be worse than stopping loudly.
 */
export const DEFAULT_MAX_ROWS_PER_CHUNK = 20_000;

export interface ChunkPage<T> {
  rows: T[] | null;
  error?: string;
}

/** Fetch one page of one chunk. `rows: null` means the read failed. */
export type ChunkFetcher<T> = (
  keys: string[],
  offset: number,
  limit: number,
) => Promise<ChunkPage<T>>;

export interface ChunkOptions {
  chunk?: number;
  page?: number;
  maxRowsPerChunk?: number;
  /** Called for anything worth a console line: a failed page, a hit guard. */
  onNote?: (note: string) => void;
}

export interface ChunkOutcome<T> {
  rows: T[];
  chunks: number;
  /**
   * How many chunks needed more than one page. Every one of these would have
   * been silently truncated by a single-shot read, so it is worth surfacing.
   */
  pagedChunks: number;
  rowsRead: number;
  /** True if any page failed or any guard fired -- the result is INCOMPLETE. */
  degraded: boolean;
}

export function chunkKeys(keys: string[], size = DEFAULT_CHUNK_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

export async function pageChunkedKeys<T>(
  keys: string[],
  fetchPage: ChunkFetcher<T>,
  opts: ChunkOptions = {},
): Promise<ChunkOutcome<T>> {
  const chunkSize = opts.chunk ?? DEFAULT_CHUNK_SIZE;
  const pageSize = opts.page ?? POSTGREST_PAGE_SIZE;
  const maxRows = opts.maxRowsPerChunk ?? DEFAULT_MAX_ROWS_PER_CHUNK;
  const note = opts.onNote ?? (() => undefined);

  const chunks = chunkKeys(keys, chunkSize);
  if (chunks.length === 0) {
    return { rows: [], chunks: 0, pagedChunks: 0, rowsRead: 0, degraded: false };
  }

  let pagedChunks = 0;
  let degraded = false;

  // Chunks concurrently (their key sets are disjoint); pages WITHIN a chunk
  // sequentially, since whether a next page exists depends on this one.
  const perChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const rows: T[] = [];
      let offset = 0;
      let pages = 0;

      for (;;) {
        const res = await fetchPage(chunk, offset, pageSize);
        if (res.rows === null) {
          note(`page at offset ${offset} failed: ${res.error ?? "unknown error"}`);
          degraded = true;
          break;
        }
        pages++;
        rows.push(...res.rows);

        if (res.rows.length < pageSize) break; // the only proof the rows ran out
        offset += res.rows.length;

        if (offset >= maxRows) {
          note(
            `a ${chunk.length}-key chunk exceeded ${maxRows} rows; stopping. ` +
            `This result IS incomplete -- narrow the query.`,
          );
          degraded = true;
          break;
        }
      }

      if (pages > 1) pagedChunks++;
      return rows;
    }),
  );

  const rows = perChunk.flat();
  return { rows, chunks: chunks.length, pagedChunks, rowsRead: rows.length, degraded };
}
