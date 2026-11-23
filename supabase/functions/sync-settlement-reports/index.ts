// sync-settlement-reports
// Discovers Amazon-scheduled GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 reports,
// downloads each report document, parses the TSV, maps every row to a P&L category,
// stores raw line items, and recomputes monthly category totals.
//
// IMPORTANT: Settlement V2 reports CANNOT be manually requested via createReport
// (Amazon returns "Request for report type 1118 is not allowed"). They are auto-scheduled
// every ~14 days. Amazon retains report documents for a maximum of 90 days, so
// historical years must have been synced while still inside that retention window.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { signRequest, getLWAAccessToken, getSpApiEndpoint } from "../_shared/sp-api-sigv4.ts";
// mapSettlementRow / parsePostedDate / parseAmount now live behind
// buildLineItems.ts, which both ingest paths share; only the row type is still
// named here. (SETTLEMENT_CATEGORIES was already unused before that move.)
import { SettlementRow } from "../_shared/settlement-mapper.ts";
import { buildLineItems, BuiltReport } from "./buildLineItems.ts";

// Carries the HTTP status out of an SP-API call so a caller can answer 429
// with 429 instead of a generic 500. Extends Error, so every existing
// `err.message` handler keeps working unchanged.
class SpApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SpApiError';
    this.status = status;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';
const RETENTION_DAYS = 90;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function overlapsRequestedRange(report: any, fromDate: string, toDate: string): boolean {
  const start = (report.dataStartTime || report.createdTime || '').slice(0, 10);
  const end = (report.dataEndTime || report.createdTime || '').slice(0, 10);
  if (!start && !end) return true;
  return (end || start) >= fromDate && (start || end) <= toDate;
}

function summarizeAmazonReport(report: any, skippedReason?: string) {
  return {
    reportId: report.reportId || null,
    reportType: report.reportType || null,
    processingStatus: report.processingStatus || null,
    createdTime: report.createdTime || null,
    dataStartTime: report.dataStartTime || null,
    dataEndTime: report.dataEndTime || null,
    marketplaceIds: report.marketplaceIds || [],
    reportDocumentIdPresent: Boolean(report.reportDocumentId),
    skippedReason: skippedReason || null,
  };
}

async function listSettlementReportsWindow(
  endpoint: string, accessToken: string, fromDate: string, toDate: string,
): Promise<{ reports: any[]; evidence: any }> {
  const all: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  const evidence = { fromDate, toDate, urlParams: null as any, pages: [] as any[], error: null as string | null };
  do {
    let url: string;
    if (nextToken) {
      const p = new URLSearchParams();
      p.set('nextToken', nextToken);
      url = `${endpoint}/reports/2021-06-30/reports?${p.toString()}`;
    } else {
      const p = new URLSearchParams();
      p.set('reportTypes', REPORT_TYPE);
      p.set('processingStatuses', 'DONE');
      p.set('pageSize', '100');
      p.set('createdSince', `${fromDate}T00:00:00Z`);
      p.set('createdUntil', `${toDate}T23:59:59Z`);
      evidence.urlParams = Object.fromEntries(p.entries());
      url = `${endpoint}/reports/2021-06-30/reports?${p.toString()}`;
    }
    // Retry on 429 with exponential backoff (SP-API getReports limit: 0.0222 req/s, burst 10)
    let res: Response | null = null;
    let attempt = 0;
    while (attempt < 5) {
      const headers = await signRequest('GET', url, '', accessToken);
      res = await fetch(url, { headers });
      if (res.status !== 429) break;
      const backoffSec = Math.min(60, 15 * Math.pow(1.5, attempt)); // 15s, 22s, 34s, 51s, 60s
      console.log(`  ⏸ 429 throttled, sleeping ${Math.round(backoffSec)}s before retry ${attempt + 1}/5`);
      await res.text().catch(() => {});
      await new Promise(r => setTimeout(r, backoffSec * 1000));
      attempt++;
    }
    if (!res || !res.ok) {
      const txt = res ? await res.text() : 'no response';
      throw new Error(`getReports failed: ${res?.status} ${txt}`);
    }
    const data = await res.json();
    console.log(`  ← getReports ${fromDate} → ${toDate}: ${data.reports?.length || 0} returned`);
    evidence.pages.push({
      page: pageCount + 1,
      returned: data.reports?.length || 0,
      reports: (data.reports || []).map((r: any) => summarizeAmazonReport(r)),
      hasNextToken: Boolean(data.nextToken),
    });
    if (data.reports) {
      for (const r of data.reports) {
        if (!r.processingStatus || r.processingStatus === 'DONE') {
          all.push(r);
        }
      }
    }
    nextToken = data.nextToken || null;
    pageCount++;
    if (pageCount > 50) break;
    if (nextToken) await new Promise(r => setTimeout(r, 12_000)); // ~12s between pages
  } while (nextToken);
  return { reports: all, evidence };
}

// Walk the retrievable creation-date range in <=85-day windows. Amazon's getReports
// only filters by creation time and retains report documents for a maximum of 90 days.
async function listSettlementReports(
  endpoint: string, accessToken: string, fromDate: string, toDate: string,
): Promise<{ reports: any[]; retentionWarning: string | null; effectiveCreatedSince: string | null; effectiveCreatedUntil: string | null; retentionCutoff: string; apiWindows: any[]; amazonReportsReturned: any[]; skippedReports: any[]; }> {
  const WINDOW_DAYS = 85;
  const now = new Date();
  const retentionStartDate = isoDate(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  const effectiveFrom = fromDate < retentionStartDate ? retentionStartDate : fromDate;
  const effectiveTo = toDate > isoDate(now) ? isoDate(now) : toDate;
  const retentionWarning = fromDate < retentionStartDate
    ? `Amazon only retains settlement report documents for ${RETENTION_DAYS} days. Reports before ${retentionStartDate} are no longer retrievable through SP-API unless they were synced earlier.`
    : null;

  if (effectiveFrom > effectiveTo) {
    console.log(`Requested range ${fromDate}→${toDate} is outside Amazon's ${RETENTION_DAYS}-day report retention window.`);
    return { reports: [], retentionWarning, effectiveCreatedSince: null, effectiveCreatedUntil: null, retentionCutoff: retentionStartDate, apiWindows: [], amazonReportsReturned: [], skippedReports: [] };
  }

  const start = new Date(`${effectiveFrom}T00:00:00Z`).getTime();
  const end = new Date(`${effectiveTo}T23:59:59Z`).getTime();
  const dayMs = 86_400_000;
  const seen = new Set<string>();
  const merged: any[] = [];
  const apiWindows: any[] = [];
  const amazonReportsReturned: any[] = [];
  const skippedReports: any[] = [];
  let cursor = start;
  while (cursor <= end) {
    const winEnd = Math.min(cursor + WINDOW_DAYS * dayMs, end);
    const f = new Date(cursor).toISOString().slice(0, 10);
    const t = new Date(winEnd).toISOString().slice(0, 10);
    console.log(`  → window ${f} → ${t}`);
    try {
      const batch = await listSettlementReportsWindow(endpoint, accessToken, f, t);
      apiWindows.push(batch.evidence);
      for (const r of batch.reports) {
        amazonReportsReturned.push(summarizeAmazonReport(r));
        if (!r.reportId) {
          skippedReports.push(summarizeAmazonReport(r, 'missing_report_id'));
        } else if (seen.has(r.reportId)) {
          skippedReports.push(summarizeAmazonReport(r, 'duplicate_report_id'));
        } else if (!overlapsRequestedRange(r, fromDate, toDate)) {
          skippedReports.push(summarizeAmazonReport(r, 'outside_requested_report_period'));
        } else {
          seen.add(r.reportId);
          merged.push(r);
        }
      }
    } catch (err: any) {
      // Don't abort entire backfill if one window fails — log and continue
      console.error(`  ✗ window ${f}→${t} failed: ${err.message}`);
      apiWindows.push({ fromDate: f, toDate: t, error: err.message, pages: [] });
    }
    cursor = winEnd + dayMs;
    // Pace ~12s between windows to respect 0.0222 req/s rate limit (burst=10).
    // 6 windows × 12s = 72s, fits comfortably under edge function timeout.
    if (cursor <= end) await new Promise(r => setTimeout(r, 12_000));
  }
  return { reports: merged, retentionWarning, effectiveCreatedSince: effectiveFrom, effectiveCreatedUntil: effectiveTo, retentionCutoff: retentionStartDate, apiWindows, amazonReportsReturned, skippedReports };
}


async function getReportDocument(
  endpoint: string, accessToken: string, documentId: string,
): Promise<{ url: string; compressionAlgorithm?: string }> {
  const url = `${endpoint}/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`;
  const headers = await signRequest('GET', url, '', accessToken);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new SpApiError(res.status, `getReportDocument failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function downloadAndDecompress(docInfo: { url: string; compressionAlgorithm?: string }): Promise<string> {
  const res = await fetch(docInfo.url);
  if (!res.ok) throw new Error(`Document download failed: ${res.status}`);
  if (docInfo.compressionAlgorithm === 'GZIP') {
    const buf = new Uint8Array(await res.arrayBuffer());
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf as any]).stream().pipeThrough(ds);
    const decompressed = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(decompressed);
  }
  return await res.text();
}

function parseTsv(text: string): SettlementRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows: SettlementRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row: SettlementRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

async function processReport(
  supabase: any, userId: string, endpoint: string, accessToken: string,
  amazonReport: any, marketplace: string,
): Promise<{ rows: number; settlementId?: string; startDate?: string; endDate?: string; currency?: string; }> {
  const amazonReportId = amazonReport.reportId;
  const documentId = amazonReport.reportDocumentId;
  if (!documentId) throw new Error('No reportDocumentId on report');

  // Upsert master record (pending)
  const { data: existing } = await supabase
    .from('settlement_reports')
    .select('id, status')
    .eq('user_id', userId)
    .eq('amazon_report_id', amazonReportId)
    .maybeSingle();

  if (existing?.status === 'parsed') {
    console.log(`Report ${amazonReportId} already parsed, skipping`);
    return { rows: 0 };
  }

  let reportRowId = existing?.id;
  if (!reportRowId) {
    const { data: ins, error: insErr } = await supabase
      .from('settlement_reports').insert({
        user_id: userId,
        amazon_report_id: amazonReportId,
        amazon_report_document_id: documentId,
        marketplace_id: amazonReport.marketplaceIds?.[0] || null,
        marketplace,
        settlement_start_date: amazonReport.dataStartTime?.slice(0, 10) || null,
        settlement_end_date: amazonReport.dataEndTime?.slice(0, 10) || null,
        status: 'downloading',
        raw_metadata: amazonReport,
      }).select('id').single();
    if (insErr) throw new Error(`insert settlement_reports: ${insErr.message}`);
    reportRowId = ins.id;
  } else {
    await supabase.from('settlement_reports')
      .update({ status: 'downloading', amazon_report_document_id: documentId })
      .eq('id', reportRowId);
  }

  // Download + parse
  const docInfo = await getReportDocument(endpoint, accessToken, documentId);
  const tsvText = await downloadAndDecompress(docInfo);
  const rows = parseTsv(tsvText);
  console.log(`Report ${amazonReportId}: parsed ${rows.length} TSV rows`);

  const built = await storeParsedReport(supabase, {
    userId, reportRowId, amazonReportId, rows, fallbackMeta: amazonReport,
  });

  return {
    rows: built.items.length,
    settlementId: built.settlementId,
    startDate: built.settlementStart,
    endDate: built.settlementEnd,
    currency: built.currency,
  };
}

// Shared tail of both ingest paths: parsed rows in, line items and the report
// header row written, nothing else. Extracted 2026-11-23 so the targeted
// re-fetch below cannot drift from the discovery sync (see buildLineItems.ts
// for why a second copy would be the wrong answer).
//
// Write order is load-bearing and unchanged: the caller has already finished
// downloading and parsing before this runs, so a failed download can never
// reach the delete and wipe good line items.
async function storeParsedReport(
  supabase: any,
  opts: {
    userId: string;
    reportRowId: string;
    amazonReportId: string;
    rows: SettlementRow[];
    fallbackMeta?: { dataStartTime?: string; dataEndTime?: string } | null;
  },
): Promise<BuiltReport> {
  const { userId, reportRowId, amazonReportId, rows, fallbackMeta } = opts;
  const built = buildLineItems(rows, { userId, reportRowId, amazonReportId });

  // Wipe any prior line items for this report (idempotency)
  await supabase.from('settlement_line_items').delete().eq('settlement_report_id', reportRowId);

  // Insert in chunks of 500
  for (let i = 0; i < built.items.length; i += 500) {
    const chunk = built.items.slice(i, i + 500);
    const { error } = await supabase.from('settlement_line_items').insert(chunk);
    if (error) throw new Error(`insert line items: ${error.message}`);
  }

  // Update master row
  await supabase.from('settlement_reports').update({
    status: 'parsed',
    rows_parsed: built.items.length,
    settlement_id: built.settlementId,
    settlement_start_date: built.settlementStart || fallbackMeta?.dataStartTime?.slice(0, 10) || null,
    settlement_end_date: built.settlementEnd || fallbackMeta?.dataEndTime?.slice(0, 10) || null,
    deposit_date: built.depositDate,
    total_amount: built.totalAmount,
    currency: built.currency,
    parsed_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', reportRowId);

  return built;
}

// Re-download and re-parse ONE report we have already stored, by its Amazon
// report id.
//
// WHY THIS EXISTS SEPARATELY FROM THE SYNC
//
// The sync path cannot do this, for three independent reasons, and each one
// alone would be enough:
//   1. it discovers reports by date window, so it cannot be pointed at one;
//   2. processReport returns early on status = 'parsed', which is every report
//      we would want to repair;
//   3. it finishes by calling recomputeMonthlyTotals for every year in the
//      window -- which still has the 1,000-row cap and the Math.abs sign loss,
//      so running it is exactly what we are avoiding until that is fixed.
//
// So this spends ONE getReportDocument call, writes only that report's rows,
// and DOES NOT TOUCH THE TOTALS. Deliberately no 429 retry: the caller is a
// human pacing calls by hand, and a throttle should stop the run rather than
// sit in a backoff loop burning the retention window. Nothing is written
// before the download succeeds, so a 429 leaves the database untouched.
async function refetchReport(
  supabase: any, userId: string, endpoint: string, accessToken: string, amazonReportId: string,
) {
  const { data: row, error: rowErr } = await supabase
    .from('settlement_reports')
    .select('id, amazon_report_document_id, currency, raw_metadata')
    .eq('user_id', userId)
    .eq('amazon_report_id', amazonReportId)
    .maybeSingle();
  if (rowErr) throw new Error(`lookup settlement_reports: ${rowErr.message}`);
  if (!row) throw new SpApiError(404, `No stored settlement report with amazon_report_id ${amazonReportId}`);
  if (!row.amazon_report_document_id) {
    // Without a stored document id the only way back is getReports, which is
    // a different and much more expensive call. Refuse rather than silently
    // widen the blast radius of a "re-fetch one report" request.
    throw new SpApiError(409, `Report ${amazonReportId} has no stored amazon_report_document_id`);
  }

  // One call. Then the download. Only then do we write anything.
  const docInfo = await getReportDocument(endpoint, accessToken, row.amazon_report_document_id);
  const tsvText = await downloadAndDecompress(docInfo);
  const rows = parseTsv(tsvText);

  const built = await storeParsedReport(supabase, {
    userId,
    reportRowId: row.id,
    amazonReportId,
    rows,
    fallbackMeta: row.raw_metadata || null,
  });

  return {
    report_id: amazonReportId,
    currency: built.currency ?? null,
    settlement_id: built.settlementId ?? null,
    start: built.settlementStart ?? null,
    end: built.settlementEnd ?? null,
    deposit_date: built.depositDate ?? null,
    tsv_rows: rows.length,
    rows_written: built.items.length,
    posted_dates_filled: built.postedDatesFilled,
    posted_dates_null: built.postedDatesNull,
    totals_recomputed: false,
  };
}

// Aggregate settlement_line_items into settlement_category_totals for a year.
//
// ⚠️ STILL BROKEN IN TWO WAYS, ON PURPOSE UNTOUCHED (2026-11-23). The currency
// filter below was added because it had to ship with the date-parser fix; the
// rest of this function is a separate, larger job and the totals it writes are
// on hold until then:
//
//   1. THE 1,000-ROW CAP. `.limit(50000)` is a REQUEST, and PostgREST clamps
//      it to this project's db-max-rows of 1,000. There is no ORDER BY, so the
//      1,000 rows that survive are arbitrary. Any year with more than 1,000
//      categorised lines is therefore aggregated from an arbitrary subset --
//      silently, because a full page looks exactly like a complete read.
//   2. THE SIGN IS DISCARDED. `cur.total += Math.abs(...)` sums fees, refunds
//      and sales as positive magnitudes, so a month's "total" for a category
//      is not a signed figure and refunds inflate rather than reduce.
//
// The fix is one server-side aggregate (join the reports, filter the currency,
// bucket by month in SQL, keep the sign, upsert non-destructively) and it needs
// its own before/after comparison against a >1,000-line mixed-sign fixture.
// Until that lands, treat settlement_category_totals as untrusted.
async function recomputeMonthlyTotals(supabase: any, userId: string, year: number) {
  // We compute per (user, year, month, marketplace=ALL, category).
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;

  // Pull raw aggregated rows (small enough — one query per year per user)
  const { data: agg, error } = await supabase.rpc('settlement_aggregate_year' as any, {
    p_user_id: userId, p_year: year,
  }).select?.() ?? { data: null, error: null } as any;

  // RPC may not exist — do it manually with a SELECT
  //
  // USD ONLY, EXPLICITLY. settlement_line_items has no currency column of its
  // own; the currency lives on the parent report, so this aggregate was
  // currency-blind. Until 2026-11-23 that was harmless by accident: every
  // non-USD line had a NULL posted_date (the dotted-date parser bug) and the
  // posted_date range filter below already excluded them, so no foreign amount
  // ever entered a USD total. Fixing the parser removes that accident -- newly
  // re-fetched CAD/MXN/BRL lines arrive dated, and without this join they
  // would be summed into the same bucket as USD at face value, no conversion.
  // The filter has to land in the same commit as the parser fix for that
  // reason; on its own today it changes nothing.
  //
  // !inner makes the join a filter rather than an optional embed, so a line
  // whose report is missing or non-USD is dropped from the result, not
  // returned with a null child.
  const { data: rows, error: aggErr } = await supabase
    .from('settlement_line_items')
    .select('posted_date, category, amount, settlement_reports!inner(currency)')
    .eq('user_id', userId)
    .eq('settlement_reports.currency', 'USD')
    .gte('posted_date', startDate)
    .lt('posted_date', endDate)
    .not('category', 'is', null)
    .limit(50000);
  if (aggErr) throw new Error(`aggregate query: ${aggErr.message}`);

  const buckets = new Map<string, { total: number; count: number; year: number; month: number; category: string }>();
  for (const r of (rows || [])) {
    if (!r.posted_date) continue;
    const d = new Date(r.posted_date);
    const yr = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const key = `${yr}-${mo}-${r.category}`;
    const cur = buckets.get(key) || { total: 0, count: 0, year: yr, month: mo, category: r.category };
    cur.total += Math.abs(Number(r.amount) || 0);
    cur.count += 1;
    buckets.set(key, cur);
  }

  // Wipe existing year's totals for this user
  await supabase.from('settlement_category_totals')
    .delete()
    .eq('user_id', userId)
    .eq('period_year', year)
    .eq('marketplace', 'ALL');

  const upserts = Array.from(buckets.values()).map(b => ({
    user_id: userId,
    period_year: b.year,
    period_month: b.month,
    marketplace: 'ALL',
    category: b.category,
    total_amount: b.total,
    row_count: b.count,
    last_recomputed_at: new Date().toISOString(),
  }));

  if (upserts.length) {
    for (let i = 0; i < upserts.length; i += 200) {
      const chunk = upserts.slice(i, i + 200);
      const { error: upErr } = await supabase.from('settlement_category_totals').insert(chunk);
      if (upErr) throw new Error(`insert totals: ${upErr.message}`);
    }
  }

  return upserts.length;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseService);
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
    const providedSecret = req.headers.get('x-internal-secret') || '';

    const body = await req.json().catch(() => ({}));

    // Two auth paths: (1) end-user with JWT, (2) internal cron with x-internal-secret + targetUserId
    let user: { id: string } | null = null;
    if (internalSecret && providedSecret && providedSecret === internalSecret && body.targetUserId) {
      user = { id: body.targetUserId };
      console.log(`[sync-settlement-reports] internal cron call for user=${body.targetUserId}`);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'No authorization' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const supabase = createClient(supabaseUrl, supabaseAnon, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) {
        return new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      user = authUser;
    }
    const action = body.action || 'sync';
    const fromDate = body.fromDate || '2025-01-01';
    const toDate = body.toDate || new Date().toISOString().slice(0, 10);
    const year = body.year || new Date().getFullYear();

    if (action === 'recompute') {
      const updated = await recomputeMonthlyTotals(supabaseAdmin, user.id, year);
      return new Response(JSON.stringify({ ok: true, action: 'recompute', categoryTotalsUpdated: updated }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === REFETCH ONE REPORT ===
    // Repairs a single already-parsed report in place. One getReportDocument
    // call, that report's rows only, and NO recompute -- see refetchReport.
    // Meant to be driven one id at a time, spaced by hand, stopping at the
    // first 429, which is why it neither loops nor retries.
    if (action === 'refetch') {
      const reportId = body.reportId || body.report_id;
      if (!reportId) {
        return new Response(JSON.stringify({ error: 'reportId is required for action=refetch' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: authRows } = await supabaseAdmin
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id')
        .eq('user_id', user.id);
      const refetchAuth = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
      if (!refetchAuth?.refresh_token) {
        return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      try {
        const accessToken = await getLWAAccessToken(refetchAuth.refresh_token);
        const endpoint = getSpApiEndpoint(refetchAuth.marketplace_id);
        const out = await refetchReport(supabaseAdmin, user.id, endpoint, accessToken, String(reportId));
        return new Response(JSON.stringify({ ok: true, action: 'refetch', ...out }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        // A throttle, a missing report and a missing document id each get their
        // own status so the caller can tell "stop pacing and wait" apart from
        // "this report can never be re-fetched". Nothing was written in any of
        // those cases: every failure here happens before the first write.
        const status = err instanceof SpApiError ? err.status : 500;
        console.error(`[refetch] report ${reportId} failed (${status}): ${err.message}`);
        return new Response(
          JSON.stringify({ ok: false, action: 'refetch', report_id: reportId, status, error: err.message, wrote_anything: false }),
          { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    // === SYNC ===
    const { data: authRows } = await supabaseAdmin
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id);
    const authData = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (!authData?.refresh_token) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(authData.refresh_token);
    const endpoint = getSpApiEndpoint(authData.marketplace_id);
    const marketplace = authData.marketplace_id === 'ATVPDKIKX0DER' ? 'US' : (authData.marketplace_id || 'US');

    console.log(`Listing settlement reports from ${fromDate} to ${toDate}`);
    const discovery = await listSettlementReports(endpoint, accessToken, fromDate, toDate);
    const reports = discovery.reports;
    if (discovery.retentionWarning) console.warn(discovery.retentionWarning);
    console.log(`Found ${reports.length} settlement reports`);

    const results: any[] = [];
    const skippedExisting: any[] = [];
    let totalRows = 0;
    let processed = 0;
    let skipped = 0;
    const errors: any[] = [];

    for (const r of reports) {
      try {
        const out = await processReport(supabaseAdmin, user.id, endpoint, accessToken, r, marketplace);
        if (out.rows === 0) {
          skipped++;
          skippedExisting.push({ ...summarizeAmazonReport(r, 'already_parsed_locally'), marketplace, currency: null });
        } else {
          processed++;
          totalRows += out.rows;
          results.push({
            reportId: r.reportId,
            reportType: r.reportType,
            marketplace,
            marketplaceIds: r.marketplaceIds || [],
            settlementId: out.settlementId,
            start: out.startDate,
            end: out.endDate,
            rows: out.rows,
            currency: out.currency,
          });
        }
        // Pace requests to respect SP-API rate limits (Reports = 0.0222 req/sec sustained)
        await new Promise(res => setTimeout(res, 800));
      } catch (err: any) {
        console.error(`Failed report ${r.reportId}:`, err.message);
        errors.push({ reportId: r.reportId, error: err.message });
        // Mark error in DB
        await supabaseAdmin.from('settlement_reports')
          .update({ status: 'error', error_message: err.message })
          .eq('user_id', user.id).eq('amazon_report_id', r.reportId);
      }
    }

    // Recompute monthly totals for affected years (start year through current year)
    const startYr = parseInt(fromDate.slice(0, 4));
    const endYr = parseInt(toDate.slice(0, 4));
    const yearsRecomputed: number[] = [];
    for (let y = startYr; y <= endYr; y++) {
      try {
        const updated = await recomputeMonthlyTotals(supabaseAdmin, user.id, y);
        yearsRecomputed.push(y);
        console.log(`Recomputed ${updated} category totals for ${y}`);
      } catch (err: any) {
        console.error(`Recompute ${y} failed:`, err.message);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      reportsFound: reports.length,
      reportsDownloaded: processed,
      processed,
      skipped,
      totalLineItems: totalRows,
      yearsRecomputed,
      retentionWarning: discovery.retentionWarning,
      requestedRange: { fromDate, toDate },
      amazonApiRange: {
        createdSince: discovery.effectiveCreatedSince,
        createdUntil: discovery.effectiveCreatedUntil,
        retentionCutoff: discovery.retentionCutoff,
        reportType: REPORT_TYPE,
      },
      effectiveCreatedSince: discovery.effectiveCreatedSince,
      effectiveCreatedUntil: discovery.effectiveCreatedUntil,
      amazonReportsReturned: discovery.amazonReportsReturned,
      skippedReports: [...discovery.skippedReports, ...skippedExisting],
      apiWindows: discovery.apiWindows,
      errors,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('sync-settlement-reports fatal:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
