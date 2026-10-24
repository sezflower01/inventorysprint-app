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
import { routeAdjustment, isFbmShippingLabelReason } from "../../fetch-profit-loss/adjustment-router.ts";

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

/**
 * These now exercise the REAL router that fetch-profit-loss and
 * repull-month-adjustments both import, not a hand-written mirror of it. The
 * mirror was the weakness: it could agree with the chain on the day it was
 * written and drift the moment either side changed, which is exactly the
 * failure a decision-table test is supposed to catch.
 */
function routeAdjustment2(t: string, amount: number): { column: string; value: number } {
  const r = routeAdjustment(t, amount);
  return r ? { column: r.column, value: r.value } : { column: "DROPPED", value: 0 };
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
    const r = routeAdjustment2(t, amt);
    assertEquals(r.column, "compensated_clawback");
    assertEquals(r.value, amt, "stored VERBATIM -- no abs(), the sign is the fact");
    total += r.value;
  }
  assertEquals(Number(total.toFixed(2)), -16.31);
});

Deno.test("REVERSAL_REIMBURSEMENT is untouched and still income", () => {
  // Measured positive from Amazon despite the name; abs() is a no-op on it.
  for (const amt of [4.70, 15.68, 20.25, 17.05, 19.53, 20.25]) {
    const r = routeAdjustment2("REVERSAL_REIMBURSEMENT", amt);
    assertEquals(r.column, "reversal_reimbursement");
    assertEquals(r.value, amt);
  }
});

Deno.test("no unrecognised adjustment is dropped for being negative", () => {
  // The old `else if (amount > 0)` discarded these entirely.
  const r = routeAdjustment2("SOME_FUTURE_AMAZON_TYPE", -12.34);
  assertEquals(r.column, "reimbursements");
  assertEquals(r.value, -12.34);
});

Deno.test("a zero-value adjustment still creates no row", () => {
  assertEquals(routeAdjustment2("SOME_FUTURE_AMAZON_TYPE", 0).column, "DROPPED");
});

Deno.test("clawback is matched BEFORE the catch-all, not by LOST or DAMAGE", () => {
  // Ordering regression: if a broader branch ever moved above it, the clawback
  // would be mis-filed as a warehouse loss.
  assertEquals(routeAdjustment2("COMPENSATED_CLAWBACK", -4.70).column, "compensated_clawback");
  // And the real types that SHOULD hit the earlier branches still do.
  assertEquals(routeAdjustment2("MISSING_FROM_INBOUND", 180.69).column, "warehouse_lost");
  assertEquals(routeAdjustment2("WAREHOUSE_DAMAGE", 3.18).column, "warehouse_damage");
  assertEquals(routeAdjustment2("FREE_REPLACEMENT_REFUND_ITEMS", 18.59).column, "free_replacement_refund_items");
});


Deno.test("POSTAGE routing keeps all six spellings the sync has always matched", () => {
  // Narrowing this to POSTAGE_BILLING alone would have reclassified SAFE-T and
  // Buy Shipping charges out of fbm_shipping_label_fee.
  for (const t of ["POSTAGE_BILLING", "ShippingServices", "shippinglabel",
                   "BuyShipping", "buy shipping", "SAFE-T", "SAFE-T_REIMBURSEMENT"]) {
    assertEquals(isFbmShippingLabelReason(t), true, `expected ${t} to match`);
    const r = routeAdjustment(t, -4.21);
    assertEquals(r?.column, "fbm_shipping_label_fee");
    assertEquals(r?.value, 4.21, "stored as a magnitude: the column is a fee");
    assertEquals(r?.postage, true);
  }
  assertEquals(isFbmShippingLabelReason("COMPENSATED_CLAWBACK"), false);
  assertEquals(isFbmShippingLabelReason(null), false);
});

Deno.test("LIQUIDATION routes to its own event_type", () => {
  const r = routeAdjustment("WHOLESALE_LIQUIDATION", 42.5);
  assertEquals(r?.eventType, "liquidation");
  assertEquals(r?.column, "liquidations");
  // a negative liquidation is the brokerage fee, handled elsewhere
  assertEquals(routeAdjustment("WHOLESALE_LIQUIDATION", -3)?.value, 0);
});

Deno.test("branch ORDER: reversal is tested before the LOST family", () => {
  // If the LOST family moved above it, a future Amazon type containing both
  // would be filed as a warehouse loss.
  assertEquals(routeAdjustment("REVERSAL_REIMBURSEMENT_LOST", 5)?.column,
    "reversal_reimbursement");
});

Deno.test("viaCatchAll separates an unmapped type from a negative mapped one", () => {
  // The false alarm this flag exists to prevent. Both land in reimbursements;
  // only one is an unrecognised AdjustmentType.
  const negLost = routeAdjustment("WAREHOUSE_LOST", -6.83);
  assertEquals(negLost?.column, "reimbursements");
  assertEquals(negLost?.viaCatchAll, false, "a negative LOST is MAPPED, not a catch-all");

  const negDamage = routeAdjustment("WAREHOUSE_DAMAGE", -5.78);
  assertEquals(negDamage?.column, "reimbursements");
  assertEquals(negDamage?.viaCatchAll, false, "a negative DAMAGE is MAPPED too");

  const unknown = routeAdjustment("SOME_TYPE_AMAZON_ADDED_LATER", -5.78);
  assertEquals(unknown?.column, "reimbursements");
  assertEquals(unknown?.viaCatchAll, true, "an unrecognised type IS the catch-all");
});

Deno.test("every mapped branch reports viaCatchAll false", () => {
  for (const [t, amt] of [
    ["POSTAGE_BILLING", -4.2], ["WHOLESALE_LIQUIDATION", 10],
    ["REVERSAL_REIMBURSEMENT", 4.7], ["MISSING_FROM_INBOUND", 5],
    ["WAREHOUSE_LOST", 5], ["WAREHOUSE_DAMAGE", 5],
    ["FREE_REPLACEMENT_REFUND_ITEMS", 5], ["COMPENSATED_CLAWBACK", -5],
  ] as Array<[string, number]>) {
    assertEquals(routeAdjustment(t, amt)?.viaCatchAll, false, `${t} must not read as catch-all`);
  }
});
