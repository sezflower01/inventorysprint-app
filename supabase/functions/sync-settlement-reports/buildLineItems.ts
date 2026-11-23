// Turns the parsed rows of ONE settlement report into the rows we store.
//
// WHY THIS IS ITS OWN MODULE
//
// Two callers now need it: the normal discovery sync (processReport) and the
// targeted re-fetch of a single already-parsed report (refetchReport, added
// 2026-11-23 to repair the foreign reports whose dates the old date parser
// could not read). Those two paths differ only in how they come by the report
// -- discovery gets it from getReports, re-fetch reads the document id we
// already stored -- and are identical from the parsed TSV onwards.
//
// Keeping that shared tail in one place is deliberate. This repo has paid for
// the alternative more than once: the web and Excel P&L reports drifted apart
// because each grew its own copy of the category list, and the COG average
// currently has four implementations that must be kept in step by hand. A second copy of the line-item mapping would be the same mistake, and
// would show up as a re-fetched report that disagrees with a freshly synced
// one for no visible reason.
//
// It is also the only way to test any of this without a network or a database:
// the function is pure, so a synthetic report goes in and the exact payload we
// would write comes out.

import {
  mapSettlementRow,
  parseAmount,
  parsePostedDate,
  SettlementRow,
} from '../_shared/settlement-mapper.ts';

export type SettlementHeader = {
  settlementId?: string;
  settlementStart?: string;
  settlementEnd?: string;
  depositDate?: string;
  totalAmount: number;
  currency?: string;
};

export type BuiltReport = SettlementHeader & {
  items: Record<string, unknown>[];
  /** Line items whose posted_date parsed. */
  postedDatesFilled: number;
  /**
   * Line items stored with a NULL posted_date. The monthly aggregate skips
   * these, so a non-zero count on a re-fetch means the date format in that
   * marketplace's file is still unreadable and the re-fetch did not achieve
   * what it was run for. This is the number that makes a re-fetch
   * self-verifying instead of merely "successful".
   */
  postedDatesNull: number;
};

/**
 * The first non-blank row of a settlement report is a summary row carrying the
 * settlement id, its period, the deposit date, the total and the currency.
 * Every later row is a transaction line.
 */
export function readSettlementHeader(rows: SettlementRow[]): SettlementHeader {
  for (const r of rows) {
    if (r['settlement-id'] && r['settlement-start-date'] && r['total-amount']) {
      return {
        settlementId: r['settlement-id'],
        settlementStart: parsePostedDate({ 'posted-date': r['settlement-start-date'] }) || undefined,
        settlementEnd: parsePostedDate({ 'posted-date': r['settlement-end-date'] }) || undefined,
        depositDate: parsePostedDate({ 'posted-date': r['deposit-date'] }) || undefined,
        totalAmount: parseAmount(r['total-amount']),
        currency: r['currency'],
      };
    }
  }
  return { totalAmount: 0 };
}

export function buildLineItems(
  rows: SettlementRow[],
  opts: { userId: string; reportRowId: string; amazonReportId: string },
): BuiltReport {
  const header = readSettlementHeader(rows);

  const items: Record<string, unknown>[] = [];
  let postedDatesFilled = 0;
  let postedDatesNull = 0;

  for (const r of rows) {
    const mapped = mapSettlementRow(r);
    if (!mapped) continue;
    if (!mapped.amount) continue;
    const postedDate = parsePostedDate(r);
    if (postedDate) postedDatesFilled++;
    else postedDatesNull++;
    items.push({
      user_id: opts.userId,
      settlement_report_id: opts.reportRowId,
      amazon_report_id: opts.amazonReportId,
      posted_date: postedDate,
      transaction_type: r['transaction-type'] || null,
      order_id: r['order-id'] || null,
      shipment_id: r['shipment-id'] || null,
      marketplace_name: r['marketplace-name'] || null,
      amount_type: r['amount-type'] || null,
      amount_description: r['amount-description'] || null,
      amount: mapped.amount,
      fulfillment_id: r['fulfillment-id'] || null,
      sku: r['sku'] || null,
      asin: null,
      quantity_purchased: r['quantity-purchased'] ? parseInt(r['quantity-purchased']) : null,
      category: mapped.category,
    });
  }

  return { ...header, items, postedDatesFilled, postedDatesNull };
}
