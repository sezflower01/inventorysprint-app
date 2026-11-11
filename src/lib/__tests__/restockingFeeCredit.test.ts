// A restocking fee is a CREDIT, and only one of three consumers knew it.
//
// Amazon charges a restocking penalty to the RETURNING BUYER -- 15%, 20% or
// 50% of the item price -- withholds it from their refund and passes it to the
// seller. Measured 2026-11-11 over all 39 events in history: every single one
// lands exactly on one of those three tiers, 0 off-tier, 0 on a "net twin"
// (17.65 / 25.00 / 100.00). Because Amazon defines the fee as a percentage OF
// THE ITEM PRICE, hitting the tier exactly proves `refunds` holds the GROSS
// sale -- confirmed independently, refund minus original sale is 0.00 on every
// single-unit order. So the credit is the OFFSET that turns a gross refund
// into the real cost to the seller.
//
// The trap: restocking_fee is the ONE financial_events_cache column stored
// POSITIVE while being a credit (ingest takes abs()). On 5,254 refund rows,
// `refunds` is positive 4742/0 (a cost) while the credits `referral_fees`
// (0/4742) and `other_fees` (0/520) are negative. Anything applying the
// documented "positive = cost" convention blindly therefore charged the seller
// for money kept -- a 2x error, $380.66 lifetime on $190.33 of credits.
//
// plModel got it right by listing the key in INCOME_ROWS, which bypasses the
// sign convention entirely. refundMath's `full` mode and RefundsSection's
// impacts() did not. These tests pin all three so they cannot drift apart
// again -- the same lesson as pl-web-excel-one-model.
//
// Do NOT "fix" this by flipping the stored sign: INCOME_ROWS needs it positive.
import { describe, it, expect } from "vitest";
import {
  plIncome,
  plExpenses,
  INCOME_ROWS,
  EXPENSE_ROWS,
  MEMO_ROWS,
  type PlMonthRow,
} from "../profitloss/plModel";
import { computeNetRefundFromFecRows, type FecRefundRow } from "../sales/refundMath";

const emptyMonth = (over: Partial<PlMonthRow> = {}): PlMonthRow =>
  ({ month_num: 10, ...over }) as PlMonthRow;

describe("restocking_fee is seller income in the P&L", () => {
  it("is an INCOME row, never an expense or a skipped memo", () => {
    const has = (rows: typeof INCOME_ROWS) =>
      rows.some((r) => r.key === "restocking_fee" || r.keys?.includes("restocking_fee"));
    expect(has(INCOME_ROWS), "buyer-charged penalty passed to the seller").toBe(true);
    expect(has(EXPENSE_ROWS), "charging it would double-count a gross refund").toBe(false);
    expect(has(MEMO_ROWS), "informational rows are skipped by sumRows()").toBe(false);
  });

  it("its label says CREDIT, so the row cannot be read as an Amazon charge", () => {
    const row = INCOME_ROWS.find((r) => r.key === "restocking_fee");
    expect(row).toBeDefined();
    // The same label reaches the Excel export, which imports INCOME_ROWS.
    expect(row!.label.toLowerCase()).toContain("credit");
    expect(row!.label.toLowerCase()).toContain("restocking");
  });

  it("INCREASES profit -- the 2026 figure the seller asked about", () => {
    const base = emptyMonth();
    const withCredit = emptyMonth({ restocking_fee: 68.36 } as Partial<PlMonthRow>);
    expect(plIncome(withCredit) - plIncome(base)).toBeCloseTo(68.36, 2);
    expect(plExpenses(withCredit) - plExpenses(base)).toBeCloseTo(0, 2);
  });
});

describe("refundMath subtracts the restocking credit from refund cost", () => {
  // The real October event: sold $32.00, returned, 20% tier.
  const oct: FecRefundRow = {
    amazon_order_id: "113-8267165-1606605",
    refunds: 32.00,          // POSITIVE = cost, booked GROSS
    referral_fees: 0,        // isolate the restocking term
    restocking_fee: 6.40,    // POSITIVE but a CREDIT
  };

  it("nets to what the buyer actually got back, not the gross refund", () => {
    const canon = computeNetRefundFromFecRows([oct], "full");
    // 32.00 - 6.40 = 25.60 is the cash that actually left the seller.
    expect(canon.refundCostNet).toBeCloseTo(25.60, 2);
  });

  it("REGRESSION: adding it instead of subtracting doubles the error", () => {
    const withCredit = computeNetRefundFromFecRows([oct], "full");
    const withoutCredit = computeNetRefundFromFecRows(
      [{ ...oct, restocking_fee: 0 }], "full");
    // The credit must REDUCE cost. The old code produced 38.40 here, i.e. the
    // credit pushed cost UP -- 12.80 away from the truth on one $32 order.
    expect(withCredit.refundCostNet).toBeLessThan(withoutCredit.refundCostNet);
    expect(withoutCredit.refundCostNet - withCredit.refundCostNet).toBeCloseTo(6.40, 2);
    expect(withCredit.refundCostNet).not.toBeCloseTo(38.40, 2);
  });

  it("principalRefunded still reports the GROSS refund", () => {
    // The credit offsets the cost; it must not quietly rewrite the gross,
    // which is what reconciles against Amazon's own refund total.
    const canon = computeNetRefundFromFecRows([oct], "full");
    expect(canon.principalRefunded).toBeCloseTo(32.00, 2);
  });

  it("`simple` mode is unchanged -- cached rows must not shift", () => {
    // simple mode exists to keep live_sales_summary bit-identical; it never
    // looked at restocking_fee and still must not.
    const simple = computeNetRefundFromFecRows([oct], "simple");
    const simpleNoCredit = computeNetRefundFromFecRows(
      [{ ...oct, restocking_fee: 0 }], "simple");
    expect(simple.refundCostNet).toBeCloseTo(simpleNoCredit.refundCostNet, 2);
    expect(simple.refundCostNet).toBeCloseTo(32.00, 2);
  });

  it("the three published tiers all behave as credits", () => {
    for (const [sale, pct] of [[23.00, 15], [32.00, 20], [17.42, 50]] as const) {
      const fee = Number((sale * pct / 100).toFixed(2));
      const canon = computeNetRefundFromFecRows(
        [{ amazon_order_id: "T" + pct, refunds: sale, referral_fees: 0, restocking_fee: fee }],
        "full",
      );
      expect(canon.refundCostNet, `${pct}% tier`).toBeCloseTo(sale - fee, 2);
    }
  });
});
