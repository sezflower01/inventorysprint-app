// The International Marketplace Profit panel re-implements plModel's taxonomy
// BY HAND, and that copy has already fallen behind once.
//
// InternationalMarketplaceProfitPanel.tsx cannot import plModel's RowDef lists
// directly, because it sums per marketplace rather than rendering rows, so it
// carries three string arrays instead: INCOME_KEYS, INCOME_DEDUCTION_KEYS and
// AMAZON_FEE_KEYS. Its own header warns twice that this is a copy -- and on
// 2026-10-23 `compensated_clawback` had to be added by hand, months after it
// became a real EXPENSE_ROWS line, because nothing connected the two files.
// Until then the panel ignored every clawback Amazon sent.
//
// This test is that connection. It fails the moment a key exists in plModel and
// not in the panel, or the reverse. A new P&L category now cannot reach the US
// report while silently skipping the international one.
//
// Verified live on 2026-11-11 before this test was written: the lists were
// already in sync, the panel's arithmetic reproduced the seller's screen to the
// cent on all three marketplaces, and no financial_events_cache column with a
// non-zero non-US 2026 total sat outside them except the two sales-tax columns,
// which belong below Net Profit.
import { describe, it, expect } from "vitest";
import { INCOME_ROWS, EXPENSE_ROWS, type RowDef } from "../profitloss/plModel";
import {
  INCOME_KEYS,
  INCOME_DEDUCTION_KEYS,
  AMAZON_FEE_KEYS,
} from "../profitloss/internationalPanelKeys";

/** Every source column a RowDef reads, flattening the multi-key rows. */
const keysOf = (rows: RowDef[]): string[] =>
  rows.flatMap((r) => (r.keys && r.keys.length > 0 ? r.keys : r.key ? [r.key] : []) as string[]);

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();

// fbm_shipping_label_fee is in neither list on purpose: plModel documents at
// length that financial_events_cache has never held a non-zero value for it, so
// a row would render 0.00 in every month and assert a false zero. If a RowDef
// for it ever appears in plModel, this test will demand it here too -- which is
// the correct outcome, since by then the data would be real.
const EXPECTED_ABSENT = ["fbm_shipping_label_fee"];

describe("international panel mirrors plModel's taxonomy", () => {
  it("income keys match INCOME_ROWS exactly", () => {
    expect(sorted(INCOME_KEYS)).toEqual(sorted(keysOf(INCOME_ROWS)));
  });

  it("cost keys match EXPENSE_ROWS exactly", () => {
    // The panel splits plModel's expenses two ways -- refunds and promos are
    // netted out of Sales, Amazon's own charges are the Amazon Fees column --
    // but together they must cover the same ground.
    const panelCosts = [...INCOME_DEDUCTION_KEYS, ...AMAZON_FEE_KEYS];
    expect(sorted(panelCosts)).toEqual(sorted(keysOf(EXPENSE_ROWS)));
  });

  it("no key is counted as both income and cost", () => {
    const costs = new Set<string>([...INCOME_DEDUCTION_KEYS, ...AMAZON_FEE_KEYS]);
    const both = INCOME_KEYS.filter((k) => costs.has(k));
    expect(both, "a key on both sides would cancel itself out").toEqual([]);
  });

  it("the restocking fee credit is income here too, never a cost", () => {
    // The whole point of the 2026-11-11 relabel: Amazon charges the restocking
    // penalty to the RETURNING BUYER and passes it to the seller, so it offsets
    // a gross refund. Charging it would understate international profit --
    // the panel's own header calls this out by name.
    expect(INCOME_KEYS).toContain("restocking_fee");
    expect(INCOME_DEDUCTION_KEYS as readonly string[]).not.toContain("restocking_fee");
    expect(AMAZON_FEE_KEYS as readonly string[]).not.toContain("restocking_fee");
  });

  it("promotional rebates and their refunds sit on opposite sides", () => {
    // Easy to get backwards: a promotional rebate is money given to the buyer,
    // a promotional-rebate refund is Amazon reversing an over-applied promo
    // back to the seller.
    expect(INCOME_KEYS).toContain("promotional_rebate_refunds");
    expect(INCOME_DEDUCTION_KEYS).toContain("promotional_rebates");
  });

  it("only the documented column is deliberately absent", () => {
    const panelAll = new Set<string>([
      ...INCOME_KEYS,
      ...INCOME_DEDUCTION_KEYS,
      ...AMAZON_FEE_KEYS,
    ]);
    const plAll = new Set<string>([...keysOf(INCOME_ROWS), ...keysOf(EXPENSE_ROWS)]);
    for (const k of EXPECTED_ABSENT) {
      expect(panelAll.has(k), `${k} should not be summed by the panel`).toBe(false);
      expect(plAll.has(k), `${k} should not be a plModel row either`).toBe(false);
    }
  });
});
