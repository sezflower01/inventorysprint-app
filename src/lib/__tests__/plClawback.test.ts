// The clawback must actually reduce Net Profit.
//
// Before 2026-10-22 compensated_clawback sat in MEMO_ROWS labelled "already in
// Reimbursements". That was false -- the RPC merges
//   reimbursements + ABS(reversal_reimbursement) + ABS(free_replacement_refund_items)
// and does NOT include clawback -- and because informational rows are skipped by
// sumRows(), clawbacks reached neither income nor expenses. It never mattered
// only because the writer never stored one: 0 rows, $0.00, across 22 months.
//
// Amounts below are the real ones from the live Finances API for 2026-10-18..22:
// three COMPENSATED_CLAWBACK items totalling -$16.31, which InventoryLab lists
// as Reimbursement_Reversal (-4.70 on SKU 1067904498, -3.27 on 8KN-OIT-P89U).
import { describe, it, expect } from "vitest";
import {
  plIncome,
  plExpenses,
  INCOME_ROWS,
  EXPENSE_ROWS,
  MEMO_ROWS,
  type PlMonthRow,
} from "../profitloss/plModel";

const emptyMonth = (over: Partial<PlMonthRow> = {}): PlMonthRow =>
  ({ month_num: 10, ...over }) as PlMonthRow;

describe("compensated_clawback is a real expense", () => {
  it("appears in EXPENSE_ROWS, not MEMO_ROWS", () => {
    const inExpenses = EXPENSE_ROWS.some(
      (r) => r.key === "compensated_clawback" || r.keys?.includes("compensated_clawback"));
    const inMemo = MEMO_ROWS.some(
      (r) => r.key === "compensated_clawback" || r.keys?.includes("compensated_clawback"));
    const inIncome = INCOME_ROWS.some(
      (r) => r.key === "compensated_clawback" || r.keys?.includes("compensated_clawback"));
    expect(inExpenses, "must be an expense row").toBe(true);
    expect(inMemo, "must no longer be a skipped memo row").toBe(false);
    expect(inIncome, "must never be income -- Amazon is taking money back").toBe(false);
  });

  it("REDUCES profit by the clawback magnitude", () => {
    // The RPC returns ABS() of the stored negative, i.e. a positive magnitude,
    // which is the convention every negative:true expense row uses.
    const without = emptyMonth({ sales: 1000 } as Partial<PlMonthRow>);
    const withClawback = emptyMonth({ sales: 1000, compensated_clawback: 16.31 } as Partial<PlMonthRow>);

    expect(plIncome(without)).toBe(plIncome(withClawback));      // income untouched
    const profitBefore = plIncome(without) + plExpenses(without);
    const profitAfter = plIncome(withClawback) + plExpenses(withClawback);
    expect(Number((profitBefore - profitAfter).toFixed(2))).toBe(16.31);
  });

  it("is NOT absorbed into income via the Reimbursements line", () => {
    // The specific failure to guard: a clawback inflating income instead of
    // reducing profit.
    const row = emptyMonth({ compensated_clawback: 16.31 } as Partial<PlMonthRow>);
    expect(plIncome(row)).toBe(0);
    expect(plExpenses(row)).toBe(-16.31);
  });
});

describe("reversal_reimbursement stays income and stays a memo", () => {
  it("is memo-only, so it is not double counted", () => {
    // Measured: Amazon sends REVERSAL_REIMBURSEMENT POSITIVE despite the name,
    // and the RPC already folds it into the reimbursements column. Adding it
    // again here would double count it.
    const row = emptyMonth({ reimbursements: 97.46, reversal_reimbursement: 97.46 } as Partial<PlMonthRow>);
    expect(plIncome(row)).toBe(97.46);
    expect(plExpenses(row)).toBe(0);
  });

  it("is not an expense", () => {
    const inExpenses = EXPENSE_ROWS.some(
      (r) => r.key === "reversal_reimbursement" || r.keys?.includes("reversal_reimbursement"));
    expect(inExpenses).toBe(false);
  });
});

describe("the two together, on the real October window", () => {
  it("returns income and clawback reduces it", () => {
    // REVERSAL_REIMBURSEMENT +97.46 (income, already merged),
    // COMPENSATED_CLAWBACK  -16.31 (expense magnitude 16.31)
    const row = emptyMonth({
      reimbursements: 97.46,
      reversal_reimbursement: 97.46,
      compensated_clawback: 16.31,
    } as Partial<PlMonthRow>);
    expect(plIncome(row)).toBe(97.46);
    expect(plExpenses(row)).toBe(-16.31);
    expect(Number((plIncome(row) + plExpenses(row)).toFixed(2))).toBe(81.15);
  });
});
