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
