// Sample payloads below are shaped from the REAL Finances API response pulled
// read-only on 2026-10-22 for 2026-10-18..22 (63 adjustment items):
//
//   MISSING_FROM_INBOUND          43 items  +638.68  all positive
//   REVERSAL_REIMBURSEMENT         6 items   +97.46  all positive
//   FREE_REPLACEMENT_REFUND_ITEMS  3 items   +44.04  all positive
//   WAREHOUSE_LOST                 6 items   +27.12  all positive
//   COMPENSATED_CLAWBACK           3 items   -16.31  ALL NEGATIVE
//   WAREHOUSE_DAMAGE               2 items    +5.96  all positive
//
// Two facts these tests pin, because both were invisible before the probe:
// SellerSKU is present on every item while ASIN is null on every item, and
// PostedDate carries a full UTC timestamp that the writer was truncating.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { adjustmentProvenance } from "../../fetch-profit-loss/adjustment-provenance.ts";

Deno.test("captures a real MISSING_FROM_INBOUND item", () => {
  const event = {
    AdjustmentType: "MISSING_FROM_INBOUND",
    PostedDate: "2026-10-19T01:40:52.000Z",
    AdjustmentItemList: [{}, {}],
  };
  const item = {
    SellerSKU: "1064965282",
    Quantity: 19,
    TotalAmount: { CurrencyCode: "USD", CurrencyAmount: 180.69 },
  };
  const p = adjustmentProvenance(event, item);
  assertEquals(p.adjustment_type, "MISSING_FROM_INBOUND");
  assertEquals(p.seller_sku, "1064965282");
  assertEquals(p.quantity, 19);
  // The FULL timestamp, not the truncated day. 01:40 UTC on the 19th is
  // 18:40 Pacific on the 18th, which is the whole reason this is kept.
  assertEquals(p.posted_at, "2026-10-19T01:40:52.000Z");
});

Deno.test("keeps the NEGATIVE clawback sign untouched in raw_event", () => {
  // These are the rows the writer currently drops entirely.
  const event = { AdjustmentType: "COMPENSATED_CLAWBACK", PostedDate: "2026-10-20T17:36:55.000Z" };
  const item = { SellerSKU: "1067904498", Quantity: 1, TotalAmount: { CurrencyAmount: -4.70, CurrencyCode: "USD" } };
  const p = adjustmentProvenance(event, item);
  assertEquals(p.adjustment_type, "COMPENSATED_CLAWBACK");
  assertEquals(p.seller_sku, "1067904498");
  const amt = (p.raw_event.AdjustmentItem as { TotalAmount: { CurrencyAmount: number } }).TotalAmount.CurrencyAmount;
  assertEquals(amt, -4.70, "the sign must survive verbatim -- it is the evidence");
});

Deno.test("captures SellerSKU even though Amazon leaves ASIN null", () => {
  // Measured: ASIN was null on all 63 items, SellerSKU present on all 63.
  const item = { SellerSKU: "JF0-EHR-72Q7", ASIN: null, Quantity: 1 };
  const p = adjustmentProvenance({ AdjustmentType: "REVERSAL_REIMBURSEMENT" }, item);
  assertEquals(p.seller_sku, "JF0-EHR-72Q7");
});

Deno.test("raw_event holds only THIS item, never the whole event", () => {
  // An N-item event must not store the full list N times.
  const event = {
    AdjustmentType: "MISSING_FROM_INBOUND",
    PostedDate: "2026-10-19T01:40:52.000Z",
    AmazonOrderId: null,
    AdjustmentItemList: [{ SellerSKU: "a" }, { SellerSKU: "b" }, { SellerSKU: "c" }],
  };
  const p = adjustmentProvenance(event, { SellerSKU: "b", Quantity: 2 });
  assertEquals(Object.keys(p.raw_event).sort(),
    ["AdjustmentItem", "AdjustmentType", "AmazonOrderId", "PostedDate"]);
  assertEquals("AdjustmentItemList" in p.raw_event, false);
  assertEquals((p.raw_event.AdjustmentItem as { SellerSKU: string }).SellerSKU, "b");
});

Deno.test("quantity coercion never yields NaN for the integer column", () => {
  assertEquals(adjustmentProvenance({}, { Quantity: "7" }).quantity, 7);
  assertEquals(adjustmentProvenance({}, { QuantityShipped: 3 }).quantity, 3);
  assertEquals(adjustmentProvenance({}, { Quantity: "abc" }).quantity, null);
  assertEquals(adjustmentProvenance({}, { Quantity: null }).quantity, null);
  assertEquals(adjustmentProvenance({}, {}).quantity, null);
  assertEquals(adjustmentProvenance({}, { Quantity: 0 }).quantity, 0);
});

Deno.test("blank and missing strings become null, not empty string", () => {
  const p = adjustmentProvenance({ AdjustmentType: "", PostedDate: "   " }, { SellerSKU: "" });
  assertEquals(p.adjustment_type, null);
  assertEquals(p.posted_at, null);
  assertEquals(p.seller_sku, null);
});

Deno.test("survives junk input without throwing", () => {
  for (const [e, i] of [[null, null], [undefined, undefined], ["x", 1], [{}, []]] as const) {
    const p = adjustmentProvenance(e, i);
    assertEquals(p.adjustment_type, null);
    assertEquals(p.quantity, null);
  }
});

/* ------------------------------------------------------------------------- *
 * The clawback branch, as a decision table.
 *
 * The writer's branch chain is inside fetchMonthEvents and not exportable, so
 * this mirrors its ORDER and asserts the routing. It is a guard against the
 * two ways the chain has been wrong:
 *   - COMPENSATED_CLAWBACK matching no branch and falling off the end
 *   - the final test being `amount > 0`, which dropped negatives silently
 * ------------------------------------------------------------------------- */

type Routed =
  | { column: "fbm_shipping_label_fee" | "liquidations" | "reversal_reimbursement"
            | "warehouse_lost" | "warehouse_damage" | "free_replacement_refund_items"
            | "compensated_clawback" | "reimbursements"; value: number }
  | { column: "DROPPED"; value: 0 };

/** Mirrors the writer's if/else order exactly. Keep in sync with index.ts. */
function routeAdjustment(adjustmentTypeRaw: string, amount: number): Routed {
  const t = adjustmentTypeRaw.toUpperCase();
  if (t.includes("POSTAGE_BILLING")) return { column: "fbm_shipping_label_fee", value: Math.abs(amount) };
  if (t.includes("LIQUIDATION")) return { column: "liquidations", value: amount > 0 ? amount : 0 };
  if (t.includes("REVERSAL_REIMBURSEMENT")) return { column: "reversal_reimbursement", value: Math.abs(amount) };
  if (t.includes("WAREHOUSE_LOST") || t.includes("MISSING_FROM_INBOUND") || t.includes("LOST"))
    return amount > 0 ? { column: "warehouse_lost", value: amount } : { column: "reimbursements", value: amount };
  if (t.includes("WAREHOUSE_DAMAGE") || t.includes("DAMAGE"))
    return amount > 0 ? { column: "warehouse_damage", value: amount } : { column: "reimbursements", value: amount };
  if (t.includes("FREE_REPLACEMENT"))
    return { column: "free_replacement_refund_items", value: amount > 0 ? amount : 0 };
  if (t.includes("COMPENSATED_CLAWBACK")) return { column: "compensated_clawback", value: amount };
  if (amount !== 0) return { column: "reimbursements", value: amount };
  return { column: "DROPPED", value: 0 };
}

Deno.test("THE FIX: a real clawback is stored, signed, not dropped", () => {
  // The three the live API returned for 2026-10-18..22, totalling -16.31.
  const real: Array<[string, number]> = [
    ["COMPENSATED_CLAWBACK", -3.27],
    ["COMPENSATED_CLAWBACK", -4.70],
    ["COMPENSATED_CLAWBACK", -8.34],
  ];
  let total = 0;
  for (const [t, amt] of real) {
    const r = routeAdjustment(t, amt);
    assertEquals(r.column, "compensated_clawback");
    assertEquals(r.value, amt, "stored VERBATIM -- no abs(), the sign is the fact");
    total += r.value;
  }
  assertEquals(Number(total.toFixed(2)), -16.31);
});

Deno.test("REVERSAL_REIMBURSEMENT is untouched and still income", () => {
  // Measured positive from Amazon despite the name; abs() is a no-op on it.
  for (const amt of [4.70, 15.68, 20.25, 17.05, 19.53, 20.25]) {
    const r = routeAdjustment("REVERSAL_REIMBURSEMENT", amt);
    assertEquals(r.column, "reversal_reimbursement");
    assertEquals(r.value, amt);
  }
});

Deno.test("no unrecognised adjustment is dropped for being negative", () => {
  // The old `else if (amount > 0)` discarded these entirely.
  const r = routeAdjustment("SOME_FUTURE_AMAZON_TYPE", -12.34);
  assertEquals(r.column, "reimbursements");
  assertEquals(r.value, -12.34);
});

Deno.test("a zero-value adjustment still creates no row", () => {
  assertEquals(routeAdjustment("SOME_FUTURE_AMAZON_TYPE", 0).column, "DROPPED");
});

Deno.test("clawback is matched BEFORE the catch-all, not by LOST or DAMAGE", () => {
  // Ordering regression: if a broader branch ever moved above it, the clawback
  // would be mis-filed as a warehouse loss.
  assertEquals(routeAdjustment("COMPENSATED_CLAWBACK", -4.70).column, "compensated_clawback");
  // And the real types that SHOULD hit the earlier branches still do.
  assertEquals(routeAdjustment("MISSING_FROM_INBOUND", 180.69).column, "warehouse_lost");
  assertEquals(routeAdjustment("WAREHOUSE_DAMAGE", 3.18).column, "warehouse_damage");
  assertEquals(routeAdjustment("FREE_REPLACEMENT_REFUND_ITEMS", 18.59).column, "free_replacement_refund_items");
});
