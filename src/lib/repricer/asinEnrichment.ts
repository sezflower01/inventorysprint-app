/**
 * Parsing and validation for the repricer's two per-ASIN enrichment RPCs.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * It exists to be tested. On 2026-11-19 the first version of these aggregates
 * shipped as PostgREST set-returning functions and was silently truncated at
 * 1,000 rows -- the live console read
 *
 *   today=1000, 7d=1000, 30d=1000, historical=1000, media=1000 ASINs
 *
 * five exact 1,000s, with no error, so every ASIN past the first thousand read
 * as "no sales" rather than "not loaded". Buried inside an 8,700-line
 * component there was nothing to point a test at. The rule that failed is
 * already recorded elsewhere in this repo -- a full page is never evidence the
 * rows ran out -- and it failed again because an RPC does not LOOK like a
 * paged read. So the check now lives somewhere a test can hold it.
 *
 * The server side is fixed by construction (one jsonb value cannot be cut by a
 * row cap). What is enforced here is the contract: received must equal the
 * count the server reports, the old capped array shape is refused outright,
 * and anything unexpected fails LOUDLY and defers to the caller's own paged
 * scan rather than quietly returning a short answer.
 */

/**
 * This project's PostgREST db-max-rows. Only used to recognise the old failure
 * when we see it, never to size a request -- `.limit()` can lower this cap but
 * nothing can raise it from the client, which is precisely why the fix had to
 * be a single row instead of a bigger page.
 */
export const POSTGREST_MAX_ROWS = 1000;

/** Uppercase, then strip everything that is not A-Z0-9. */
export const normalizeIdentifier = (value?: string | null): string =>
  (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface SalesWindows {
  salesTodayMap: Record<string, number>;
  sales7Map: Record<string, number>;
  salesMap: Record<string, number>;
  historicalSalesMap: Record<string, { totalUnits: number; earliestDate: string }>;
}

export type TitleImageMap = Record<string, { title?: string; image_url?: string }>;

export const emptySalesWindows = (): SalesWindows => ({
  salesTodayMap: {},
  sales7Map: {},
  salesMap: {},
  historicalSalesMap: {},
});

/**
 * Deliberately ONE interface rather than a discriminated union of
 * {ok:true,...} | {ok:false,...}. tsconfig.app.json sets "strict": false, so
 * narrowing by a boolean literal discriminant is not dependable here -- the
 * union version compiled clean under `npm run build` (Rollup does not
 * typecheck) and then produced ten errors under tsc. A flat shape cannot be
 * read wrongly under any strictness setting.
 *
 * `value` is null exactly when `ok` is false, and `reason` is non-null exactly
 * then. Callers must check `ok` before using `value`.
 */
export interface ParseResult<T> {
  ok: boolean;
  value: T | null;
  rows: number | null;
  reason: string | null;
}

interface Envelope {
  generated_at?: unknown;
  rows?: unknown;
  truncated?: unknown;
  asins?: unknown;
}

/**
 * Shared shape checks for both RPCs.
 *
 * Refusing the array shape matters as much as the count check: the dropped
 * RETURNS TABLE functions returned an array, so an array means something is
 * still serving the capped version and the caller must not trust it -- a
 * length of exactly POSTGREST_MAX_ROWS says so outright.
 */
function openEnvelope(raw: unknown): ParseResult<Record<string, unknown>> {
  if (raw == null) {
    return { ok: false, value: null, reason: "empty response", rows: null };
  }

  if (Array.isArray(raw)) {
    const capped = raw.length === POSTGREST_MAX_ROWS;
    return {
      ok: false,
      value: null,
      rows: raw.length,
      reason: capped
        ? `array of exactly ${POSTGREST_MAX_ROWS} rows -- this is the PostgREST row cap, ` +
          `so the result is TRUNCATED. A set-returning function is being called where a ` +
          `jsonb one is expected; apply migration 20261119060000.`
        : `array of ${raw.length} rows where a jsonb envelope was expected -- the old ` +
          `set-returning function is still in place and can truncate at ${POSTGREST_MAX_ROWS}.`,
    };
  }

  if (typeof raw !== "object") {
    return { ok: false, value: null, reason: `unexpected ${typeof raw} response`, rows: null };
  }

  const env = raw as Envelope;
  const rows = typeof env.rows === "number" ? env.rows : null;

  if (env.truncated === true) {
    return {
      ok: false,
      value: null,
      rows,
      reason:
        `server reported ${rows ?? "?"} ASINs, above its p_max_asins guard, so it withheld ` +
        `the payload rather than send a short one. Use the paged scan.`,
    };
  }

  if (env.asins == null || typeof env.asins !== "object" || Array.isArray(env.asins)) {
    return { ok: false, value: null, reason: "envelope has no asins object", rows };
  }

  const asins = env.asins as Record<string, unknown>;
  const received = Object.keys(asins).length;

  // Received vs expected. Inside one jsonb value these cannot legitimately
  // disagree, so a mismatch means the response was altered or clipped in
  // transit -- the condition that went unnoticed last time.
  if (rows == null) {
    return { ok: false, value: null, reason: `envelope has no row count (received ${received})`, rows: null };
  }
  if (received !== rows) {
    return {
      ok: false,
      value: null,
      rows,
      reason: `received ${received} ASINs but the server counted ${rows} -- response is incomplete`,
    };
  }

  return { ok: true, value: asins, rows, reason: null };
}

/** Shape of one entry in get_repricer_asin_sales_json's `asins` map. */
interface SalesEntry {
  today?: unknown;
  d7?: unknown;
  d30?: unknown;
  life?: unknown;
  first?: unknown;
  last?: unknown;
}

const asCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseSalesEnvelope(raw: unknown): ParseResult<SalesWindows> {
  const opened = openEnvelope(raw);
  if (!opened.ok || !opened.value) {
    return { ok: false, value: null, rows: opened.rows, reason: opened.reason };
  }

  const out = emptySalesWindows();
  for (const [rawAsin, rawEntry] of Object.entries(opened.value)) {
    const asin = normalizeIdentifier(rawAsin);
    if (!asin || rawEntry == null || typeof rawEntry !== "object") continue;
    const e = rawEntry as SalesEntry;

    out.salesTodayMap[asin] = asCount(e.today);
    out.sales7Map[asin] = asCount(e.d7);
    out.salesMap[asin] = asCount(e.d30);

    // A lifetime count is only useful WITH a first-sale date: the consumer
    // divides by days-since to get a rate, so a count with no date would read
    // as "sold N in one day".
    const life = asCount(e.life);
    if (life > 0 && typeof e.first === "string" && e.first) {
      out.historicalSalesMap[asin] = { totalUnits: life, earliestDate: e.first };
    }
  }

  return { ok: true, value: out, rows: opened.rows, reason: null };
}

interface MediaEntry {
  title?: unknown;
  image?: unknown;
}

export function parseMediaEnvelope(raw: unknown): ParseResult<TitleImageMap> {
  const opened = openEnvelope(raw);
  if (!opened.ok || !opened.value) {
    return { ok: false, value: null, rows: opened.rows, reason: opened.reason };
  }

  const out: TitleImageMap = {};
  for (const [rawAsin, rawEntry] of Object.entries(opened.value)) {
    const asin = normalizeIdentifier(rawAsin);
    if (!asin || rawEntry == null || typeof rawEntry !== "object") continue;
    const e = rawEntry as MediaEntry;
    out[asin] = {
      title: typeof e.title === "string" && e.title ? e.title : undefined,
      image_url: typeof e.image === "string" && e.image ? e.image : undefined,
    };
  }

  return { ok: true, value: out, rows: opened.rows, reason: null };
}
