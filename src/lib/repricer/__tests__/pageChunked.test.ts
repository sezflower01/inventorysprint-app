import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  POSTGREST_PAGE_SIZE,
  chunkKeys,
  pageChunkedKeys,
  type ChunkFetcher,
} from "../pageChunked";

interface Row {
  key: string;
  n: number;
}

/**
 * A fake table that behaves like this project's PostgREST: it NEVER returns
 * more than POSTGREST_PAGE_SIZE rows, whatever limit is asked for. That clamp
 * is the whole point -- a correct reader must page until a page comes back
 * short rather than trust a full one.
 */
function fakeTable(rowsPerKey: (key: string) => number) {
  let requests = 0;
  const fetcher: ChunkFetcher<Row> = async (keys, offset, limit) => {
    requests++;
    const all: Row[] = [];
    for (const key of [...keys].sort()) {
      for (let n = 0; n < rowsPerKey(key); n++) all.push({ key, n });
    }
    const effective = Math.min(limit, POSTGREST_PAGE_SIZE);
    return { rows: all.slice(offset, offset + effective) };
  };
  return { fetcher, requestCount: () => requests };
}

const keysFor = (count: number) =>
  Array.from({ length: count }, (_, i) => `B${String(i).padStart(9, "0")}`);

describe("pageChunkedKeys", () => {
  it("THE DEFECT: a 500-key chunk with 3 rows each is 1,500 rows, and all arrive", () => {
    // 500 keys is the chunk size, so this is ONE chunk -- and a single-shot
    // read of it would have come back with exactly 1,000 of the 1,500 rows,
    // full and apparently complete.
    return (async () => {
      const keys = keysFor(DEFAULT_CHUNK_SIZE);
      const t = fakeTable(() => 3);
      const out = await pageChunkedKeys(keys, t.fetcher);

      expect(out.rowsRead).toBe(1500);
      expect(out.chunks).toBe(1);
      expect(out.pagedChunks).toBe(1);
      expect(out.degraded).toBe(false);
      // Every key is represented with all three of its rows.
      const byKey = new Map<string, number>();
      for (const r of out.rows) byKey.set(r.key, (byKey.get(r.key) ?? 0) + 1);
      expect(byKey.size).toBe(DEFAULT_CHUNK_SIZE);
      expect([...byKey.values()].every(v => v === 3)).toBe(true);
    })();
  });

  it("the single-shot read it replaced would have lost a third of them", async () => {
    const keys = keysFor(DEFAULT_CHUNK_SIZE);
    const t = fakeTable(() => 3);
    // One request, no paging -- what batchInQuery used to do.
    const single = await t.fetcher(keys, 0, 5000);
    expect(single.rows).toHaveLength(POSTGREST_PAGE_SIZE); // not 1500
    // And it looks complete: a full page with no error.
    const keysSeen = new Set(single.rows!.map(r => r.key));
    expect(keysSeen.size).toBeLessThan(DEFAULT_CHUNK_SIZE);
  });

  it("one key with more rows than the cap is still read in full", async () => {
    const t = fakeTable(key => (key === "B000000000" ? 2500 : 1));
    const out = await pageChunkedKeys(keysFor(10), t.fetcher);
    expect(out.rowsRead).toBe(2500 + 9);
    expect(out.rows.filter(r => r.key === "B000000000")).toHaveLength(2500);
    expect(out.degraded).toBe(false);
  });

  it("a page that returns EXACTLY the page size is not treated as the end", async () => {
    // 1,000 rows on the nose: the boundary case. A reader that stops on a full
    // page cannot tell this from "there were only 1,000".
    const t = fakeTable(() => 1);
    const out = await pageChunkedKeys(keysFor(POSTGREST_PAGE_SIZE), t.fetcher, { chunk: POSTGREST_PAGE_SIZE });
    expect(out.rowsRead).toBe(POSTGREST_PAGE_SIZE);
    expect(out.degraded).toBe(false);
    // It had to ask again to find out, and the second page came back empty.
    expect(t.requestCount()).toBe(2);
  });

  it("chunk size changes the number of requests, never the answer", async () => {
    const keys = keysFor(1200);
    const results = [];
    for (const chunk of [100, 500, 1200]) {
      const t = fakeTable(() => 2);
      const out = await pageChunkedKeys(keys, t.fetcher, { chunk });
      results.push({ chunk, rows: out.rowsRead, requests: t.requestCount() });
    }
    expect(results.every(r => r.rows === 2400)).toBe(true);
    // Different costs, same total.
    expect(new Set(results.map(r => r.requests)).size).toBeGreaterThan(1);
  });

  it("a failed page marks the result degraded instead of returning a short answer quietly", async () => {
    const notes: string[] = [];
    const fetcher: ChunkFetcher<Row> = async (_keys, offset) =>
      offset === 0 ? { rows: null, error: "statement timeout" } : { rows: [] };
    const out = await pageChunkedKeys(keysFor(10), fetcher, { onNote: n => notes.push(n) });

    expect(out.degraded).toBe(true);
    expect(out.rowsRead).toBe(0);
    expect(notes.join(" ")).toMatch(/statement timeout/);
  });

  it("the runaway guard stops, says the result is incomplete, and does not loop", async () => {
    const notes: string[] = [];
    // A table that always returns a full page: without a guard this never ends.
    const fetcher: ChunkFetcher<Row> = async () => ({
      rows: Array.from({ length: POSTGREST_PAGE_SIZE }, (_, n) => ({ key: "k", n })),
    });
    const out = await pageChunkedKeys(keysFor(1), fetcher, {
      maxRowsPerChunk: 3000,
      onNote: n => notes.push(n),
    });

    expect(out.degraded).toBe(true);
    expect(out.rowsRead).toBe(3000);
    expect(notes.join(" ")).toMatch(/IS incomplete/);
  });

  it("no keys means no requests", async () => {
    const t = fakeTable(() => 5);
    const out = await pageChunkedKeys([], t.fetcher);
    expect(out).toEqual({ rows: [], chunks: 0, pagedChunks: 0, rowsRead: 0, degraded: false });
    expect(t.requestCount()).toBe(0);
  });

  it("pagedChunks counts exactly the chunks a single-shot read would have cut", async () => {
    // Keys 0-499 have 3 rows each (1,500 -> needs paging); 500-999 have 1 each
    // (500 -> one page is enough).
    const t = fakeTable(key => (Number(key.slice(1)) < 500 ? 3 : 1));
    const out = await pageChunkedKeys(keysFor(1000), t.fetcher, { chunk: 500 });
    expect(out.chunks).toBe(2);
    expect(out.pagedChunks).toBe(1);
    expect(out.rowsRead).toBe(1500 + 500);
  });

  it("chunkKeys splits without losing or duplicating a key", () => {
    const keys = keysFor(1201);
    const chunks = chunkKeys(keys, 500);
    expect(chunks.map(c => c.length)).toEqual([500, 500, 201]);
    expect(new Set(chunks.flat()).size).toBe(1201);
  });

  it("pages within a chunk are sequential, because the next page's existence depends on this one", async () => {
    const order: number[] = [];
    const fetcher = vi.fn<ChunkFetcher<Row>>(async (_keys, offset) => {
      order.push(offset);
      return offset === 0
        ? { rows: Array.from({ length: POSTGREST_PAGE_SIZE }, (_, n) => ({ key: "k", n })) }
        : { rows: [{ key: "k", n: 9999 }] };
    });
    const out = await pageChunkedKeys(keysFor(1), fetcher);
    expect(order).toEqual([0, POSTGREST_PAGE_SIZE]);
    expect(out.rowsRead).toBe(POSTGREST_PAGE_SIZE + 1);
  });
});
