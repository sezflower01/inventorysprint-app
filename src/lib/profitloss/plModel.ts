/**
 * The single definition of the P&L.
 *
 * WHY THIS FILE EXISTS. The Web P&L and the Excel export each carried their own
 * category list, their own totals formula and their own data source. They drifted,
 * and on 2026-08-19 the same year reconciled to two different Net Profits:
 *
 *   Web   -$5,297.33      Excel  -$2,797.61      difference  $2,499.72
 *
 * decomposing exactly as:
 *   income      +$3,146.17  4 income categories the Excel total had no line for
 *   expenses    -$5,905.35  6 fee categories the Excel total never summed
 *                           (shipping_chargeback alone was $5,423.69)
 *   inventory     +$257.60  Excel read inventory_writeoffs; the Web P&L had no
 *                           write-off term at all, and the two also computed
 *                           disposition loss differently
 *   COGS            +$1.86
 *
 * None of that was a classification DECISION. The export loaded
 * digital_services_fee, fba_inbound_convenience_fee, liquidations_brokerage_fee,
 * re_commerce_grading_charge and hrr_non_apparel into its summary object and then
 * simply never added them up; shipping_chargeback was not even mapped.
 *
 * So both reports now import their category lists, their totals and their
 * disposition rule from here, and the export reads the SAME RPC
 * (get_monthly_pl_breakdown) the screen reads. Equality is structural: to change
 * one report you have to change the definition both share.
 *
 * ⚠️ Adding a category to the source data is NOT enough to get it into the P&L.
 * It must be added to INCOME_ROWS or EXPENSE_ROWS below, or it is silently
 * dropped from both reports — which is the exact bug this file was written for.
 *
 * ⚠️ AND the row list is only HALF the path. The category must also appear in
 * get_monthly_pl_breakdown / get_pl_live_summary, or a RowDef pointing at it
 * reads undefined and renders 0.00 in every month — indistinguishable from a
 * genuine zero. fbm_shipping_label_fee was written to financial_events_cache
 * from 2026-05-26 and reached neither RPC until 2026-08-31, so a real cost
 * (~$1,178 across 2026) was never subtracted from Net Profit. It surfaced only
 * by reconciling against InventoryLab, which had the line and we did not.
 *
 * So: source column → RPC RETURNS TABLE → RPC aggregate → RowDef here. Four
 * steps, and skipping any one of them fails silently.
 */

/** One month of get_monthly_pl_breakdown. */
export interface PlMonthRow {
  month_num: number;
  sales: number;
  refunds: number;
  reimbursements: number;
  shipping_credits: number;
  shipping_credit_refunds: number;
  gift_wrap_credits: number;
  gift_wrap_credit_refunds: number;
  promotional_rebates: number;
  promotional_rebate_refunds: number;
  other_income: number;
  liquidations: number;
  intl_markets: number;
  referral_fees: number;
  fba_fees: number;
  variable_closing_fees: number;
  fixed_closing_fees: number;
  fba_inbound_fees: number;
  fba_storage_fees: number;
  fba_removal_fees: number;
  fba_disposal_fees: number;
  fba_long_term_storage_fees: number;
  fba_customer_return_fees: number;
  digital_services_fee: number;
  fba_inbound_convenience_fee: number;
  other_fees: number;
  liquidations_brokerage_fee: number;
  re_commerce_grading_charge: number;
  compensated_clawback: number;
  hrr_non_apparel: number;
  warehouse_lost: number;
  warehouse_damage: number;
  reversal_reimbursement: number;
  free_replacement_refund_items: number;
  sales_tax_collected: number;
  marketplace_facilitator_tax: number;
  sales_tax_refunds: number;
  marketplace_facilitator_tax_refunds: number;
  shipping_chargeback: number;
  shipping_chargeback_refund: number;
  restocking_fee: number;
  fbm_shipping_label_fee: number;
}

export interface RowDef {
  label: string;
  /** Single source column. Use `keys` to sum several (e.g. closing = variable + fixed). */
  key?: keyof PlMonthRow;
  /** Sum of multiple source columns. */
  keys?: (keyof PlMonthRow)[];
  /** true → render as negative (expense / refund) */
  negative?: boolean;
  /** indent (sub-row) */
  indent?: boolean;
  /** bold header row (no values) */
  header?: boolean;
  /** display only — never included in a section total (avoids double counting) */
  informational?: boolean;
}

export const rowValue = (r: PlMonthRow, d: RowDef): number => {
  if (d.keys && d.keys.length > 0) {
    return d.keys.reduce((acc, k) => acc + Number(r[k] ?? 0), 0);
  }
  if (d.key) return Number(r[d.key] ?? 0);
  return 0;
};

export const INCOME_ROWS: RowDef[] = [
  { label: "Sales", key: "sales" },
  // Merged total (generic + reversal + free-replacement subtypes) from the RPC.
  // Subtype rows live in MEMO_ROWS and must never be added again.
  { label: "Reimbursements", key: "reimbursements" },
  { label: "Shipping Credits", key: "shipping_credits" },
  { label: "Gift Wrap Credits", key: "gift_wrap_credits" },
  { label: "Promotional Rebate Refunds", key: "promotional_rebate_refunds" },
  { label: "Restocking Fee", key: "restocking_fee" },
  { label: "Other Income", key: "other_income" },
  { label: "Liquidations", key: "liquidations" },
  { label: "Warehouse Lost", key: "warehouse_lost" },
  { label: "Warehouse Damage", key: "warehouse_damage" },
  { label: "Shipping Chargeback Refund (FBM / FBA Remote Fulfillment)", key: "shipping_chargeback_refund" },
  // Refunds, Shipping Credit Refunds, Gift Wrap Credit Refunds and Promotional
  // Rebates are EXPENSE_ROWS below, not negative income. Net Profit is the same
  // either way; the ilStyleView toggle moves them back for display only.
];

export const EXPENSE_ROWS: RowDef[] = [
  { label: "Referral Fees", key: "referral_fees", negative: true },
  // Amazon's SP-API splits these; InventoryLab shows one line, so they are merged.
  { label: "Closing Fees", keys: ["variable_closing_fees", "fixed_closing_fees"], negative: true },
  { label: "FBA Fulfillment Fees", key: "fba_fees", negative: true },
  { label: "FBA Customer Return Per Unit Fee", key: "fba_customer_return_fees", negative: true },
  { label: "FBA Inbound Fees", key: "fba_inbound_fees", negative: true },
  { label: "FBA Inbound Convenience Fee", key: "fba_inbound_convenience_fee", negative: true },
  { label: "FBA Storage Fees", key: "fba_storage_fees", negative: true },
  { label: "FBA Removal Fees", key: "fba_removal_fees", negative: true },
  { label: "FBA Disposal Fees", key: "fba_disposal_fees", negative: true },
  { label: "Long-Term Storage Fees", key: "fba_long_term_storage_fees", negative: true },
  { label: "Digital Services Fee", key: "digital_services_fee", negative: true },
  { label: "Amazon Fee Adjustments (Net)", key: "other_fees", negative: true },
  { label: "Liquidations Brokerage Fee", key: "liquidations_brokerage_fee", negative: true },
  { label: "Re-Commerce Grading Charge", key: "re_commerce_grading_charge", negative: true },
  { label: "High Return Rate (Non-Apparel)", key: "hrr_non_apparel", negative: true },
  // Amazon-purchased shipping label billed back to the seller. Comes from both
  // FBM Buy Shipping AND FBA Remote Fulfillment (e.g. US FBA shipped to CA/MX).
  { label: "Shipping Chargebacks (FBM Buy Shipping / FBA Remote Fulfillment)", key: "shipping_chargeback", negative: true },
  // NO ROW for fbm_shipping_label_fee, deliberately. 20260831140000 wired the
  // column through both RPCs, and applying it reported 0.00 for the whole of
  // 2026 -- financial_events_cache has never held a single non-zero value.
  // Amazon does not deliver this seller's FBM label costs as financial events.
  //
  // The money is real and it is tracked: sales_orders.shipping_label_fee, filled
  // by sync-fbm-label-cost / poll-fbm-label-costs, and rendered in Live Sales.
  // It has simply never reached the P&L, which reads financial_events_cache for
  // fees. InventoryLab reports the same money as "MFN Shipping Label Cost"
  // ($1,148.26 for 2026), which is how the gap was found.
  //
  // A RowDef here would render 0.00 in every month -- indistinguishable from a
  // genuine zero, and a stronger false claim than showing nothing at all. The
  // real fix reads sales_orders the way COGS already does, via its own RPC.
  // ── Reclassified from Income (customer refunds and promotions) ────────
  { label: "Refunds", key: "refunds", negative: true },
  { label: "Shipping Credit Refunds", key: "shipping_credit_refunds", negative: true },
  { label: "Gift Wrap Credit Refunds", key: "gift_wrap_credit_refunds", negative: true },
  { label: "Promotional Rebates", key: "promotional_rebates", negative: true },
];

/** Sales tax — shown below Net Profit, informational. Never part of profit. */
export const OTHER_ROWS: RowDef[] = [
  { label: "Sales Tax Collected", key: "sales_tax_collected" },
  { label: "Marketplace Facilitator Tax", key: "marketplace_facilitator_tax", negative: true },
  { label: "Sales Tax Refunds", key: "sales_tax_refunds", negative: true },
  { label: "Marketplace Facilitator Tax Refunds", key: "marketplace_facilitator_tax_refunds" },
];

/** Already counted inside a line above. Shown for audit, never summed. */
export const MEMO_ROWS: RowDef[] = [
  { label: "Compensated Clawbacks / Reversal Reimbursements (already in Reimbursements)", keys: ["compensated_clawback", "reversal_reimbursement"], informational: true },
  { label: "Free Replacement Refund Items (already in Reimbursements)", key: "free_replacement_refund_items", informational: true },
  { label: "Amazon International Markets (already in Sales)", key: "intl_markets", informational: true },
];

/** Sum a set of row definitions for one month. `informational` rows are skipped. */
export function sumRows(row: PlMonthRow, defs: RowDef[]): number {
  return defs.reduce((acc, d) => {
    if (d.informational) return acc;
    const v = rowValue(row, d);
    return acc + (d.negative ? -v : v);
  }, 0);
}

/** Total income for one month (positive contributions only). */
export const plIncome = (row: PlMonthRow) => sumRows(row, INCOME_ROWS);

/**
 * Total Amazon expenses for one month, returned NEGATIVE (as it contributes to
 * profit), matching how the on-screen breakdown adds it.
 */
export const plExpenses = (row: PlMonthRow) => sumRows(row, EXPENSE_ROWS);

export interface DispositionRowLike {
  sellable_qty?: number | null;
  unsellable_qty?: number | null;
  unit_cost?: number | null;
  recovery_amount?: number | null;
  outcome?: string | null;
}

/** Statuses that count as a real, accepted disposition. */
export const DISPOSITION_STATUSES = ["accepted", "adjusted"] as const;

/**
 * Loss from one disposition row, and how many units it represents.
 *
 * OUTCOME-AWARE, and that is the whole point. Once the seller records a business
 * outcome the row is no longer "Amazon lost N unsellable units" -- the entire
 * quantity left the business, so SELLABLE units are lost too. The Excel export
 * used to count only `unsellable` regardless of outcome and therefore understated
 * the loss on exactly those rows, which is part of why the two reports disagreed
 * on Inventory Loss.
 */
export function dispositionLoss(r: DispositionRowLike): { loss: number; units: number } {
  const sellable = Number(r.sellable_qty) || 0;
  const unsellable = Number(r.unsellable_qty) || 0;
  const cost = Number(r.unit_cost) || 0;
  const recovery = Number(r.recovery_amount) || 0;
  const o = (r.outcome as string) || "pending";
  const businessOutcome =
    o === "sold_elsewhere" || o === "disposed" || o === "restricted_unsold" || o === "partial_recovery";
  // Amazon-reported loss only counts when no business outcome has taken over.
  const amazonLoss = businessOutcome ? 0 : Math.max(0, unsellable * cost - recovery);
  const businessLoss = businessOutcome ? Math.max(0, (sellable + unsellable) * cost - recovery) : 0;
  const loss = amazonLoss + businessLoss;
  if (loss <= 0) return { loss: 0, units: 0 };
  return { loss, units: businessOutcome ? sellable + unsellable : unsellable };
}

/**
 * Net Profit for one month, from components both reports compute identically.
 *
 * Inventory loss is `disposition + writeoff`. The write-off half comes from
 * inventory_writeoffs and was missing from the Web P&L entirely -- it had no
 * write-off term, so real inventory losses never reached the on-screen profit.
 */
export function plNetProfit(args: {
  income: number;
  expenses: number;
  cogs: number;
  opExpenses: number;
  disposition: number;
  writeoff: number;
}): number {
  return (
    args.income + args.expenses - args.cogs - args.opExpenses - args.disposition - args.writeoff
  );
}
