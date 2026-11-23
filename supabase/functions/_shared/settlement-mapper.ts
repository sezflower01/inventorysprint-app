// Maps a Settlement Report V2 row to a P&L category.
// Based on Amazon SP-API V2 flat file documentation + a2x mapping rules.

export type SettlementRow = {
  'transaction-type'?: string;
  'amount-type'?: string;
  'amount-description'?: string;
  amount?: string;
  'fulfillment-id'?: string;
  'posted-date-time'?: string;
  'posted-date'?: string;
  'order-id'?: string;
  'shipment-id'?: string;
  'marketplace-name'?: string;
  sku?: string;
  'merchant-order-id'?: string;
  'quantity-purchased'?: string;
  [k: string]: string | undefined;
};

export type Mapped = {
  category: string;
  amount: number;
};

// Parse amount string handling EU comma format ("95,00") and dot format ("95.00")
export function parseAmount(s?: string): number {
  if (!s) return 0;
  const t = s.trim().replace(/\s/g, '');
  if (!t) return 0;
  // If contains both comma and dot, comma is thousand separator (US format)
  if (t.includes(',') && t.includes('.')) {
    return parseFloat(t.replace(/,/g, '')) || 0;
  }
  // If only comma, treat as decimal separator (EU format)
  if (t.includes(',') && !t.includes('.')) {
    return parseFloat(t.replace(',', '.')) || 0;
  }
  return parseFloat(t) || 0;
}

// Build YYYY-MM-DD from numeric parts, verifying the day actually exists in
// that month. Date.UTC(2026, 1, 31) silently rolls to 3 March, so the
// round-trip comparison is what makes an impossible date return null instead
// of a plausible wrong one.
function isoFromParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1970 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Settlement rows carry their posted date in the MARKETPLACE's own date
 * convention, not one canonical format. Measured 2026-11-23 by downloading a
 * single CAD settlement report (one getReportDocument call, read-only probe):
 *
 *   US  (USD) -> "2026-11-08 12:00:00 UTC"   year-first, dash-separated
 *   CA  (CAD) -> "28.10.2026 15:54:28 UTC"   DAY-first, DOT-separated
 *
 * The CA form is why every non-USD line in settlement_line_items has a NULL
 * posted_date (100% of the CAD, MXN and BRL lines): the old implementation
 * handed the string straight to new Date(), which cannot read a dotted
 * day-first date, so it returned null and the row was stored undated. The
 * monthly aggregate skips undated lines, so no USD total was ever
 * contaminated -- the cost was missing months on foreign lines, not wrong ones.
 *
 * MX and BR are assumed to be dotted day-first too (100% of their lines are
 * undated, which is the same signature), but only the CAD file was sampled.
 * Re-fetching one MXN and one BRL report after this ships is what confirms it:
 * dates appear => same format; still null => a third format to add here.
 *
 * AMBIGUOUS INPUT RETURNS NULL ON PURPOSE. "08/11/2026" is 8 November in a
 * day-first marketplace and 11 August in a month-first one, and nothing in the
 * row says which. The old code fell through to new Date(), which always chose
 * month-first, so a day-first file would have been stored with the day and
 * month SWAPPED -- a wrong date that looks completely plausible and can never
 * be spotted afterwards. A null is visibly missing and can be re-fetched; a
 * silently swapped date cannot. So a slash- or dash-separated date is only
 * accepted when one component is > 12 and therefore FORCES the order. That is
 * deduction, not a guess.
 *
 * Returns the date as written in the file. Both sampled formats carry an
 * explicit " UTC" suffix, so the written date is already the UTC date and the
 * time of day is not needed.
 */
export function parsePostedDate(row: SettlementRow): string | null {
  const raw = row['posted-date-time'] || row['posted-date'];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Dotted: day-first (CA, and very likely MX/BR). Dots are only ever used
  //    day-first, so this order is a convention and not an inference. A
  //    trailing time is ignored; isoFromParts rejects a month > 12, so a
  //    hypothetical dotted month-first file fails loudly instead of flipping.
  const dotted = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D|$)/);
  if (dotted) {
    return isoFromParts(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
  }

  // 2. Slash or dash with the YEAR LAST: accepted only when forced.
  //    (A dash-separated date with the year FIRST is ISO and falls through to
  //    step 3; this pattern cannot match it, because the year is 4 digits.)
  const yearLast = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\D|$)/);
  if (yearLast) {
    const first = Number(yearLast[1]);
    const second = Number(yearLast[2]);
    const year = Number(yearLast[3]);
    if (first > 12 && second <= 12) return isoFromParts(year, second, first); // DD/MM forced
    if (second > 12 && first <= 12) return isoFromParts(year, first, second); // MM/DD forced
    return null; // ambiguous -- see the header comment
  }

  // 3. Year-first / ISO, which is what the US flat file sends. Unchanged
  //    behaviour: " UTC" becomes "Z" and the single separating space becomes
  //    "T", then the runtime parses it.
  const s = trimmed.replace(' UTC', 'Z').replace(' ', 'T');
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Map a settlement V2 row to one of our P&L categories.
 * Returns null if the row should be ignored (e.g. transfer rows, tax that we already track elsewhere, etc.)
 */
export function mapSettlementRow(row: SettlementRow): Mapped | null {
  const tt = (row['transaction-type'] || '').toLowerCase().trim();
  const at = (row['amount-type'] || '').toLowerCase().trim();
  const ad = (row['amount-description'] || '').toLowerCase().trim();
  const fid = (row['fulfillment-id'] || '').toUpperCase().trim();
  const amount = parseAmount(row.amount);

  if (!amount && !tt) return null;

  // === SALES ===
  if (tt === 'order' && at === 'itemprice' && ad === 'principal') {
    return { category: 'sales', amount };
  }
  if (tt === 'order' && at === 'itemprice' && ad === 'shipping') {
    return { category: 'shipping_credits', amount };
  }
  if (tt === 'order' && at === 'itemprice' && (ad === 'giftwrap' || ad === 'gift wrap')) {
    return { category: 'gift_wrap_credits', amount };
  }
  if (tt === 'order' && at === 'promotion') {
    return { category: 'promotional_rebates', amount };
  }

  // === REFUNDS ===
  if (tt === 'refund' && at === 'itemprice' && ad === 'principal') {
    return { category: 'refunds', amount };
  }
  if (tt === 'refund' && at === 'itemprice' && ad === 'shipping') {
    return { category: 'shipping_credit_refunds', amount };
  }
  if (tt === 'refund' && at === 'promotion') {
    return { category: 'promotional_rebate_refunds', amount };
  }

  // === FEES (Order/Refund-related) ===
  if (at === 'itemfees' && ad === 'commission') {
    return { category: 'referral_fees', amount };
  }
  if (at === 'itemfees' && (ad.includes('fbaperunitfulfillment') || ad === 'fbaperunitfulfillmentfee')) {
    return { category: 'fba_fees', amount };
  }
  if (at === 'itemfees' && ad === 'variableclosingfee') {
    return { category: 'variable_closing_fees', amount };
  }
  if (at === 'itemfees' && ad === 'fixedclosingfee') {
    return { category: 'fixed_closing_fees', amount };
  }
  if (at === 'itemfees' && ad === 'shippingchargeback') {
    return { category: 'shipping_chargeback', amount };
  }

  // === SERVICE FEES (the critical missing piece for InventoryLab parity) ===
  if (tt === 'servicefee' || tt === 'service fee' || at === 'servicefee') {
    if (ad.includes('storage') && ad.includes('long')) {
      return { category: 'fba_long_term_storage_fees', amount };
    }
    if (ad.includes('storage')) {
      return { category: 'fba_storage_fees', amount };
    }
    if (ad.includes('removal')) {
      return { category: 'fba_removal_fees', amount };
    }
    if (ad.includes('disposal')) {
      return { category: 'fba_disposal_fees', amount };
    }
    if (ad.includes('inbound')) {
      return { category: 'fba_inbound_fees', amount };
    }
    if (ad.includes('subscription')) {
      return { category: 'subscription_fees', amount };
    }
    return { category: 'other_fees', amount };
  }

  // === FBA WAREHOUSE FEES (top-level transaction-type categories) ===
  if (tt === 'fba inventory fee' || tt === 'storage fee' || tt === 'fbainventoryfee') {
    if (ad.includes('long')) return { category: 'fba_long_term_storage_fees', amount };
    return { category: 'fba_storage_fees', amount };
  }
  if (tt === 'removalcomplete' || tt.includes('removal')) {
    return { category: 'fba_removal_fees', amount };
  }
  if (tt === 'disposalcomplete' || tt.includes('disposal')) {
    return { category: 'fba_disposal_fees', amount };
  }

  // === LIQUIDATIONS ===
  if (tt === 'liquidations' && at === 'itemprice' && ad === 'principal') {
    return { category: 'liquidations', amount };
  }
  if (tt === 'liquidations' && at === 'itemfees') {
    return { category: 'liquidations_brokerage_fee', amount };
  }

  // === REIMBURSEMENTS ===
  if (at === 'fba inventory reimbursement' || ad.includes('inventoryreimbursement') || tt === 'adjustment' && ad.includes('reimbursement')) {
    return { category: 'reimbursements', amount };
  }

  // === TAXES (collected/refunded — for InventoryLab parity) ===
  if (at === 'itemwithheldtax' || ad === 'marketplacefacilitatortax-principal') {
    return { category: 'marketplace_facilitator_tax', amount };
  }
  if (at === 'itemprice' && ad === 'tax') {
    return { category: 'sales_tax_collected', amount };
  }

  // === OTHER (catch-all for adjustments, chargebacks, misc service fees) ===
  if (tt === 'adjustment' || tt === 'other') {
    return { category: 'other_fees', amount };
  }

  return null;
}

export const SETTLEMENT_CATEGORIES = [
  'sales','refunds','shipping_credits','shipping_credit_refunds',
  'gift_wrap_credits','promotional_rebates','promotional_rebate_refunds',
  'referral_fees','fba_fees','variable_closing_fees','fixed_closing_fees',
  'shipping_chargeback','fba_storage_fees','fba_long_term_storage_fees',
  'fba_removal_fees','fba_disposal_fees','fba_inbound_fees',
  'subscription_fees','other_fees','liquidations','liquidations_brokerage_fee',
  'reimbursements','marketplace_facilitator_tax','sales_tax_collected',
];
