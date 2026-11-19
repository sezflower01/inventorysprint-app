/**
 * Shared paginated Supabase fetch helper.
 *
 * Supabase / PostgREST caps every response at db-max-rows (1000 here) and
 * truncates SILENTLY — no error is raised. For YTD / large-period reports that
 * causes systematic undercounts in totals (revenue, fees, refunds, promotions),
 * so every Sales / P&L query over a large table and a long window MUST come
 * through here.
 *
 * Usage:
 *   const rows = await fetchAllPages<MyRow>(() =>
 *     supabase.from('sales_orders')
 *       .select('...')
 *       .eq('user_id', userId)
 *       .gte('order_date', start)
 *       .lte('order_date', end)
 *   , { label: 'sales_orders YTD' });
 *
 * IMPORTANT: do NOT chain `.range()` or `.limit()` on the builder you pass in —
 * this helper applies pagination itself.
 *
 * ── Two things this helper used to get wrong ───────────────────────────────
 *
 * 1. A STABLE ORDER WAS ONLY "RECOMMENDED", IN A COMMENT.
 *
 * Paging with `.range()` over an unordered query is not safe: two successive
 * requests are two independent queries, and Postgres promises nothing about
 * row order between them, so a row can arrive twice or never. A comment asking
 * callers to remember is not a guarantee — measured 2026-11-19, 7 of the
 * helper's call sites passed no order at all, including every query in
 * promotionDeductions.ts, which feeds P&L money. The helper now applies a
 * tiebreaker itself, AFTER the caller's own filters, so a caller's `.order()`
 * stays primary and this only makes ties deterministic.
 *
 * 2. AN INCOMPLETE READ RETURNED A SHORT ARRAY THAT LOOKED COMPLETE.
 *
 * On a page error, or on hitting the hard cap, it logged a warning, broke, and
 * returned the rows it had. The caller could not tell "all the rows" from
 * "some of the rows" and summed them either way — the exact shape of defect
 * this file exists to prevent, one layer up. A page error is now retried once
 * (most are transient statement timeouts under load), and a genuinely
 * incomplete read is reported through `onIncomplete` and logged as an ERROR
 * saying the totals are understated.
 *
 * `fetchAllPages` still returns `T[]` so no existing caller changes behaviour.
 * New code that sums money should prefer `fetchAllPagesResult`, which hands
 * back `complete` alongside the rows and lets the caller refuse to display a
 * total it cannot stand behind.
 */

export interface IncompleteInfo {
  reason: "error" | "hard-cap";
  /** How many rows were collected before giving up. */
  rows: number;
  detail?: string;
}

export interface FetchAllPagesOptions {
  pageSize?: number;     // default 1000 (PostgREST max per request)
  hardCap?: number;      // default 100_000 (safety brake)
  label?: string;        // for log lines
  /**
   * Stable tiebreaker applied by the helper. Every table read this way has
   * `id`; pass an explicit column for a view that does not, or `null` to opt
   * out entirely (only correct when the query cannot return more than one
   * page, in which case you do not need this helper).
   */
  orderBy?: string | null;
  /** Called once if the result is INCOMPLETE. */
  onIncomplete?: (info: IncompleteInfo) => void;
  /**
   * Throw instead of returning a partial result. Correct whenever the caller
   * would otherwise present a figure it cannot stand behind: an error state is
   * honest, a quietly understated total is not. Default false, so existing
   * callers are unchanged -- turning it on for the money paths is a one-line
   * change per call site.
   */
  throwOnIncomplete?: boolean;
  /** Retry delay in ms for a failed page. Tests pass 0. */
  retryDelayMs?: number;
}

export interface FetchAllPagesResult<T> {
  rows: T[];
  /** False means rows are MISSING — do not sum them and present a total. */
  complete: boolean;
  pages: number;
  incomplete?: IncompleteInfo;
}

/**
 * A factory for a Supabase/PostgREST query chain. Not usefully typeable here:
 * the chain's type depends on the table and the select string, and this helper
 * is deliberately agnostic to both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryBuilderFactory = () => any;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllPagesResult<T = any>(
  buildQuery: QueryBuilderFactory,
  opts: FetchAllPagesOptions = {},
): Promise<FetchAllPagesResult<T>> {
  const pageSize = opts.pageSize ?? 1000;
  const hardCap = opts.hardCap ?? 100_000;
  const label = opts.label ?? "fetchAllPages";
  const orderBy = opts.orderBy === undefined ? "id" : opts.orderBy;
  const retryDelayMs = opts.retryDelayMs ?? 250;

  const all: T[] = [];
  let from = 0;
  let pages = 0;

  const fail = (info: IncompleteInfo): FetchAllPagesResult<T> => {
    console.error(
      `[${label}] READ IS INCOMPLETE (${info.reason}): stopped at ${info.rows} rows` +
      (info.detail ? ` — ${info.detail}` : "") +
      `. Any total computed from this is UNDERSTATED.`,
    );
    opts.onIncomplete?.(info);
    if (opts.throwOnIncomplete) {
      throw new Error(
        `[${label}] read incomplete (${info.reason}) after ${info.rows} rows` +
        (info.detail ? `: ${info.detail}` : ""),
      );
    }
    return { rows: all, complete: false, pages, incomplete: info };
  };

  for (;;) {
    const to = from + pageSize - 1;

    // Order AFTER the caller's own builder so their .order() stays primary and
    // this is only the tiebreaker; .range() last so it beats any .limit().
    const runPage = async () => {
      let q = buildQuery();
      if (orderBy) q = q.order(orderBy, { ascending: true });
      return q.range(from, to);
    };

    let { data, error } = await runPage();
    if (error) {
      // One retry. Most failures here are transient statement timeouts under
      // load, and the old code turned every one of them into a quietly
      // understated total.
      console.warn(`[${label}] page ${from}-${to} failed (${error.message}); retrying once`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      ({ data, error } = await runPage());
    }
    if (error) {
      return fail({ reason: "error", rows: all.length, detail: error.message });
    }

    const chunk = (data || []) as T[];
    pages++;
    all.push(...chunk);

    // A short page is the ONLY proof the rows ran out. A full one never is.
    if (chunk.length < pageSize) break;

    from += pageSize;
    if (from >= hardCap) {
      return fail({ reason: "hard-cap", rows: all.length, detail: `hard cap ${hardCap}` });
    }
  }

  return { rows: all, complete: true, pages };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllPages<T = any>(
  buildQuery: QueryBuilderFactory,
  opts: FetchAllPagesOptions = {},
): Promise<T[]> {
  const res = await fetchAllPagesResult<T>(buildQuery, opts);
  return res.rows;
}
