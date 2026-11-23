// Tests for the targeted settlement re-fetch added 2026-11-23.
//
// ── WHAT IS ACTUALLY AT RISK HERE ────────────────────────────────────────
//
// The re-fetch exists to repair the foreign settlement reports whose posted
// dates the old parser could not read. Only 15 of them are still inside
// Amazon's ~90-day document retention, the earliest expiring within days, and
// a settlement report cannot be re-requested (report type 1118 refuses
// createReport). So each report is a ONE-SHOT, EXPIRING opportunity, and the
// two ways to waste one are:
//
//   1. spending the call and not noticing the dates are still missing. Hence
//      posted_dates_filled / posted_dates_null in the response: a re-fetch
//      that reports "ok" while writing undated rows has achieved nothing, and
//      the caller must be able to see that before spending the next call.
//   2. triggering recomputeMonthlyTotals, which still has the 1,000-row cap
//      and the Math.abs sign loss. The sync path ends by calling it for every
//      year in its window; this path must never reach it.
//
// (2) is a property of POSITION and ABSENCE, not of a return value, so it is
// pinned by reading the source -- the same approach as
// _tests/internal-caller-gate/ordering_test.ts, for the same reason: a test
// that only checked the response would have passed against the bug.
//
// Every fixture below is synthetic. No real order ids, skus, amounts or
// marketplace data appear.
//
//   deno test --allow-read \
//     supabase/functions/_tests/settlement-refetch/refetch_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildLineItems, readSettlementHeader } from '../../sync-settlement-reports/buildLineItems.ts';
import type { SettlementRow } from '../../_shared/settlement-mapper.ts';

const OPTS = {
  userId: '00000000-0000-0000-0000-000000000001',
  reportRowId: '00000000-0000-0000-0000-0000000000aa',
  amazonReportId: 'SYNTHREPORT0001',
};

// ── fixtures ─────────────────────────────────────────────────────────────

/** A settlement report's summary row, in whichever date format is passed. */
function headerRow(dates: { start: string; end: string; deposit: string }, currency: string): SettlementRow {
  return {
    'settlement-id': 'SYNTHSETTLEMENT1',
    'settlement-start-date': dates.start,
    'settlement-end-date': dates.end,
    'deposit-date': dates.deposit,
    'total-amount': '100.00',
    currency,
  };
}

/** One ordinary sale line: principal, which maps to the 'sales' category. */
function saleRow(postedDateTime: string, amount = '10.00'): SettlementRow {
  return {
    'transaction-type': 'Order',
    'amount-type': 'ItemPrice',
    'amount-description': 'Principal',
    amount,
    'posted-date-time': postedDateTime,
    'order-id': 'SYNTH-ORDER-1',
    sku: 'SYNTH-SKU-A',
    'quantity-purchased': '1',
  };
}

/** One referral fee line, to prove more than one category is picked up. */
function feeRow(postedDateTime: string): SettlementRow {
  return {
    'transaction-type': 'Order',
    'amount-type': 'ItemFees',
    'amount-description': 'Commission',
    amount: '-1.50',
    'posted-date-time': postedDateTime,
    'order-id': 'SYNTH-ORDER-1',
    sku: 'SYNTH-SKU-A',
  };
}

const US_DATES = { start: '2026-11-01', end: '2026-11-15', deposit: '2026-11-17' };
const CA_DATES = { start: '28.10.2026', end: '11.11.2026', deposit: '13.11.2026' };

// ── 1. the US path must be unchanged ─────────────────────────────────────

Deno.test('US report: every line dated, header dates parsed', () => {
  const rows = [
    headerRow(US_DATES, 'USD'),
    saleRow('2026-11-08 12:00:00 UTC'),
    feeRow('2026-11-08 12:00:00 UTC'),
  ];
  const built = buildLineItems(rows, OPTS);

  assertEquals(built.items.length, 2);
  assertEquals(built.postedDatesFilled, 2);
  assertEquals(built.postedDatesNull, 0);
  assertEquals(built.currency, 'USD');
  assertEquals(built.settlementId, 'SYNTHSETTLEMENT1');
  assertEquals(built.settlementStart, '2026-11-01');
  assertEquals(built.settlementEnd, '2026-11-15');
  assertEquals(built.depositDate, '2026-11-17');
  assertEquals(built.totalAmount, 100);
  assertEquals(built.items.map((i) => i.category).sort(), ['referral_fees', 'sales']);
  assertEquals(built.items[0].posted_date, '2026-11-08');
});

// ── 2. the foreign path is the whole point ───────────────────────────────

Deno.test('CA report: dotted day-first dates now fill, including the deposit date', () => {
  const rows = [
    headerRow(CA_DATES, 'CAD'),
    saleRow('28.10.2026 15:54:28 UTC'),
    saleRow('02.11.2026 09:00:00 UTC', '12.00'),
    feeRow('28.10.2026 15:54:28 UTC'),
  ];
  const built = buildLineItems(rows, OPTS);

  // Before the parser fix every one of these was null, which is the entire
  // reason this report is being re-fetched.
  assertEquals(built.postedDatesNull, 0, 're-fetching a CAD report must fill every posted_date');
  assertEquals(built.postedDatesFilled, 3);
  assertEquals(built.currency, 'CAD');
  assertEquals(built.items[0].posted_date, '2026-10-28');
  // 02.11.2026 is 2 November, not 11 February: day-first.
  assertEquals(built.items[1].posted_date, '2026-11-02');
  // deposit_date had no fallback, so it was simply absent on every foreign
  // report; the reconciliation reads it.
  assertEquals(built.depositDate, '2026-11-13');
  // 11.11 is the same date either way, but it must still parse.
  assertEquals(built.settlementEnd, '2026-11-11');
  assertEquals(built.settlementStart, '2026-10-28');
});

Deno.test('an unreadable date format is counted, not hidden', () => {
  // The signature of "there is a third date format we have not seen". The
  // rows are still written -- dropping them would lose the amounts too -- but
  // posted_dates_null is non-zero, so the caller knows to stop before
  // spending the next report's one retrievable call.
  const rows = [
    headerRow({ start: '1 de enero de 2026', end: '15 de enero de 2026', deposit: '17 de enero de 2026' }, 'MXN'),
    saleRow('8 de noviembre de 2026'),
    saleRow('9 de noviembre de 2026', '12.00'),
  ];
  const built = buildLineItems(rows, OPTS);

  assertEquals(built.items.length, 2, 'rows are still stored');
  assertEquals(built.postedDatesFilled, 0);
  assertEquals(built.postedDatesNull, 2, 'an unreadable format must be visible in the response');
  assertEquals(built.items[0].posted_date, null);
  assertEquals(built.settlementStart, undefined);
  assertEquals(built.depositDate, undefined);
});

Deno.test('an ambiguous slash date is counted as missing, never guessed', () => {
  const rows = [headerRow(US_DATES, 'USD'), saleRow('08/11/2026 12:00:00 UTC')];
  const built = buildLineItems(rows, OPTS);
  assertEquals(built.items[0].posted_date, null);
  assertEquals(built.postedDatesNull, 1);
});

// ── 3. the payload must not drift from what the sync writes ──────────────

Deno.test('line item payload shape is pinned', () => {
  const built = buildLineItems([headerRow(US_DATES, 'USD'), saleRow('2026-11-08 12:00:00 UTC')], OPTS);
  const item = built.items[0];

  assertEquals(Object.keys(item).sort(), [
    'amazon_report_id', 'amount', 'amount_description', 'amount_type', 'asin',
    'category', 'fulfillment_id', 'marketplace_name', 'order_id', 'posted_date',
    'quantity_purchased', 'settlement_report_id', 'shipment_id', 'sku',
    'transaction_type', 'user_id',
  ]);
  assertEquals(item.user_id, OPTS.userId);
  assertEquals(item.settlement_report_id, OPTS.reportRowId);
  assertEquals(item.amazon_report_id, OPTS.amazonReportId);
  assertEquals(item.amount, 10);
  assertEquals(item.quantity_purchased, 1);
  assertEquals(item.asin, null);
});

Deno.test('unmapped and zero-amount rows are skipped, as before', () => {
  const rows = [
    headerRow(US_DATES, 'USD'),
    saleRow('2026-11-08 12:00:00 UTC'),
    // A transfer row maps to nothing.
    { 'transaction-type': 'Transfer', amount: '-50.00', 'posted-date-time': '2026-11-09 12:00:00 UTC' },
    // A zero amount is dropped even though the row maps.
    saleRow('2026-11-10 12:00:00 UTC', '0.00'),
  ];
  const built = buildLineItems(rows, OPTS);
  assertEquals(built.items.length, 1);
  assertEquals(built.postedDatesFilled, 1);
  assertEquals(built.postedDatesNull, 0, 'a skipped row must not be counted as an undated one');
});

Deno.test('a report with no summary row yields no header, not a crash', () => {
  const built = buildLineItems([saleRow('2026-11-08 12:00:00 UTC')], OPTS);
  assertEquals(built.settlementId, undefined);
  assertEquals(built.currency, undefined);
  assertEquals(built.totalAmount, 0);
  assertEquals(built.items.length, 1);
  assertEquals(readSettlementHeader([]).totalAmount, 0);
});

// ── 4. position and absence, read from the source ────────────────────────

const SRC = await Deno.readTextFile(
  new URL('../../sync-settlement-reports/index.ts', import.meta.url),
);

/** The body of a top-level `async function <name>(`, to its closing brace. */
function functionBody(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found in sync-settlement-reports/index.ts`);
  const end = SRC.indexOf('\n}\n', start);
  assert(end > start, `could not find the end of ${name}`);
  return SRC.slice(start, end);
}

Deno.test('refetchReport never recomputes the monthly totals', () => {
  // The totals are on hold: recomputeMonthlyTotals still reads through a
  // 1,000-row cap with no ORDER BY and sums Math.abs(amount). A re-fetch that
  // called it would rewrite settlement_category_totals from an arbitrary
  // subset of rows, as a side effect of repairing some dates.
  const body = functionBody('refetchReport');
  assert(
    !body.includes('recomputeMonthlyTotals'),
    'refetchReport must not call recomputeMonthlyTotals while the totals are on hold',
  );
  // And the handler that invokes it must not either.
  const handler = SRC.slice(SRC.indexOf("if (action === 'refetch')"), SRC.indexOf('// === SYNC ==='));
  assert(handler.length > 0, 'the refetch action handler was not found');
  assert(
    !handler.includes('recomputeMonthlyTotals'),
    'the refetch handler must not recompute totals',
  );
  // The sync path, by contrast, still does -- pinned so this test is known to
  // be looking at a real distinction rather than at a string that is simply
  // absent from the whole file.
  assertStringIncludes(SRC, 'await recomputeMonthlyTotals(supabaseAdmin, user.id, y)');
});

Deno.test('refetchReport downloads before it writes anything', () => {
  // storeParsedReport deletes the report's existing line items before
  // inserting the new ones. If the download could fail after that delete, a
  // throttle or an expired document would leave the report EMPTY and
  // unrecoverable -- the data is past Amazon's retention for 75 of these
  // reports already. So the order is the safety property.
  const body = functionBody('refetchReport');
  const got = body.indexOf('getReportDocument(');
  const downloaded = body.indexOf('downloadAndDecompress(');
  const parsed = body.indexOf('parseTsv(');
  const stored = body.indexOf('storeParsedReport(');
  assert(got > 0 && downloaded > got, 'download must follow getReportDocument');
  assert(parsed > downloaded, 'parse must follow the download');
  assert(stored > parsed, 'nothing may be written before the report is parsed');
  assert(
    !body.includes('.delete('),
    'refetchReport must not delete anything itself; storeParsedReport owns the write order',
  );
});

Deno.test('refetchReport spends exactly one getReportDocument call and does not retry', () => {
  const body = functionBody('refetchReport');
  assertEquals(
    body.split('getReportDocument(').length - 1, 1,
    'one report, one document call',
  );
  // No discovery call: the whole point is to use the document id we stored.
  assert(!body.includes('listSettlementReports'), 'refetch must not call getReports');
  // No backoff loop: a 429 must stop the run, not sit in a retry that burns
  // the expiring retention window.
  assert(!/while\s*\(/.test(body), 'refetchReport must not contain a retry loop');
  assert(!body.includes('setTimeout'), 'refetchReport must not sleep');
});

Deno.test('the aggregate filters to USD through the parent report', () => {
  // settlement_line_items has no currency column; the currency is on the
  // report. Without this join a newly dated CAD line is summed into the USD
  // total at face value.
  assertStringIncludes(SRC, 'settlement_reports!inner(currency)');
  assertStringIncludes(SRC, ".eq('settlement_reports.currency', 'USD')");
});
