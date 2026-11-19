import { describe, expect, it, vi } from "vitest";
import { fetchAllPages, fetchAllPagesResult } from "../paginatedFetch";

/**
 * A stand-in for a PostgREST query builder: records the `.order()` calls made
 * on it and clamps every response to the page size, the way db-max-rows does.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a fake PostgREST chain
   is untyped by nature; typing it would test the mock, not the pager. */
function fakeBuilder(totalRows: number, opts: { failOffsets?: number[]; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const failOffsets = new Set(opts.failOffsets ?? []);
  const orderCalls: Array<{ col: string; ascending: boolean }> = [];
  const attempts: number[] = [];

  const build = () => {
      const q: any = {
      order(col: string, o: { ascending: boolean }) {
        orderCalls.push({ col, ascending: o.ascending });
        return q;
      },
      async range(from: number, to: number) {
        attempts.push(from);
        if (failOffsets.has(from)) {
          failOffsets.delete(from); // fail once, so a retry can succeed
          return { data: null, error: { message: "canceling statement due to statement timeout" } };
        }
        const limit = Math.min(to - from + 1, pageSize);
        const rows = [];
        for (let i = from; i < Math.min(from + limit, totalRows); i++) rows.push({ id: i, amount: 1 });
        return { data: rows, error: null };
      },
    };
    return q;
  };

  return { build, orderCalls, attempts };
}

describe("fetchAllPagesResult", () => {
  it("reads every page and reports complete", async () => {
    const f = fakeBuilder(2500);
    const res = await fetchAllPagesResult(f.build, { retryDelayMs: 0 });
    expect(res.rows).toHaveLength(2500);
    expect(res.complete).toBe(true);
    expect(res.pages).toBe(3);
  });

  it("applies a stable tiebreaker itself, so a caller cannot forget", async () => {
    // The old helper only RECOMMENDED this in a comment, and 7 call sites did
    // not do it -- including every query feeding P&L promotion deductions.
    const f = fakeBuilder(1500);
    await fetchAllPagesResult(f.build, { retryDelayMs: 0 });
    expect(f.orderCalls.length).toBeGreaterThan(0);
    expect(f.orderCalls.every(o => o.col === "id" && o.ascending)).toBe(true);
  });

  it("an explicit orderBy wins, and null opts out", async () => {
    const withCol = fakeBuilder(10);
    await fetchAllPagesResult(withCol.build, { orderBy: "event_date", retryDelayMs: 0 });
    expect(withCol.orderCalls.map(o => o.col)).toEqual(["event_date"]);

    const none = fakeBuilder(10);
    await fetchAllPagesResult(none.build, { orderBy: null, retryDelayMs: 0 });
    expect(none.orderCalls).toHaveLength(0);
  });

  it("a page that returns EXACTLY the page size is not treated as the end", async () => {
    const f = fakeBuilder(1000);
    const res = await fetchAllPagesResult(f.build, { retryDelayMs: 0 });
    expect(res.rows).toHaveLength(1000);
    expect(res.complete).toBe(true);
    // It had to ask again to learn there was nothing more.
    expect(f.attempts).toEqual([0, 1000]);
  });

  it("retries a failed page once, so a transient timeout is not a lost total", async () => {
    const f = fakeBuilder(2500, { failOffsets: [1000] });
    const res = await fetchAllPagesResult(f.build, { retryDelayMs: 0 });
    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(2500);
    // offset 1000 was attempted twice.
    expect(f.attempts.filter(a => a === 1000)).toHaveLength(2);
  });

  it("THE DEFECT: a page that keeps failing yields complete=false, not a short array that looks whole", async () => {
    const build = () => {
      const q: any = {
        order: () => q,
        async range(from: number) {
          if (from === 0) return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null };
          return { data: null, error: { message: "statement timeout" } };
        },
      };
      return q;
    };
    const onIncomplete = vi.fn();
    const res = await fetchAllPagesResult(build, { retryDelayMs: 0, onIncomplete });

    // The old helper returned exactly this array and said nothing.
    expect(res.rows).toHaveLength(1000);
    expect(res.complete).toBe(false);
    expect(res.incomplete?.reason).toBe("error");
    expect(onIncomplete).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "error", rows: 1000 }),
    );
  });

  it("hitting the hard cap is reported as incomplete, not as the answer", async () => {
    const f = fakeBuilder(50_000);
    const onIncomplete = vi.fn();
    const res = await fetchAllPagesResult(f.build, { hardCap: 3000, retryDelayMs: 0, onIncomplete });
    expect(res.complete).toBe(false);
    expect(res.incomplete?.reason).toBe("hard-cap");
    expect(res.rows).toHaveLength(3000);
    expect(onIncomplete).toHaveBeenCalled();
  });

  it("throwOnIncomplete turns a partial read into an error, for callers that must not guess", async () => {
    const build = () => {
      const q: any = {
        order: () => q,
        async range(from: number) {
          if (from === 0) return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null };
          return { data: null, error: { message: "statement timeout" } };
        },
      };
      return q;
    };
    await expect(
      fetchAllPagesResult(build, { retryDelayMs: 0, throwOnIncomplete: true }),
    ).rejects.toThrow(/read incomplete \(error\) after 1000 rows/);
  });

  it("throwOnIncomplete does NOT throw on a complete read", async () => {
    const f = fakeBuilder(1500);
    const res = await fetchAllPagesResult(f.build, { retryDelayMs: 0, throwOnIncomplete: true });
    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(1500);
  });

  it("an empty table is complete, not incomplete", async () => {
    const f = fakeBuilder(0);
    const res = await fetchAllPagesResult(f.build, { retryDelayMs: 0 });
    expect(res.rows).toHaveLength(0);
    expect(res.complete).toBe(true);
    expect(res.pages).toBe(1);
  });

  it("page size changes the request count, never the row count", async () => {
    const results = [];
    for (const pageSize of [100, 500, 1000]) {
      const f = fakeBuilder(1200, { pageSize });
      const res = await fetchAllPagesResult(f.build, { pageSize, retryDelayMs: 0 });
      results.push({ pageSize, rows: res.rows.length, pages: res.pages });
    }
    expect(results.every(r => r.rows === 1200)).toBe(true);
    expect(new Set(results.map(r => r.pages)).size).toBeGreaterThan(1);
  });
});

describe("fetchAllPages", () => {
  it("still returns a bare array, so existing callers are unchanged", async () => {
    const f = fakeBuilder(1500);
    const rows = await fetchAllPages(f.build, { retryDelayMs: 0 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1500);
  });
});
