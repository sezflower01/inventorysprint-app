import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mergeOrderItemsByAsin } from "./order-items.ts";

/** The real payload shape from order 111-8310672-6833058, 2026-09-08. */
const REAL_ORDER = [
  {
    ASIN: "B07FN34L97",
    SellerSKU: "1066196620",
    OrderItemId: "169335557996641",
    Title: "JB Weld JB33106 Superweld Instant Setting High Strength, 6 Gram Bottle",
    QuantityOrdered: 2,
    QuantityShipped: 2,
    ItemPrice: { CurrencyCode: "USD", Amount: "15.78" },
    ItemTax: { CurrencyCode: "USD", Amount: "0.94" },
  },
  {
    ASIN: "B07FN34L97",
    SellerSKU: "1066196620",
    OrderItemId: "169229418255161",
    Title: "JB Weld JB33106 Superweld Instant Setting High Strength, 6 Gram Bottle",
    QuantityOrdered: 1,
    QuantityShipped: 1,
    ItemPrice: { CurrencyCode: "USD", Amount: "7.89" },
    ItemTax: { CurrencyCode: "USD", Amount: "0.47" },
  },
];

Deno.test("the real collapsed order: 2 lines of one ASIN become 3 units at 23.67", () => {
  const out = mergeOrderItemsByAsin(REAL_ORDER);
  assertEquals(out.length, 1);
  assertEquals(out[0].QuantityOrdered, 3);
  assertEquals(out[0].QuantityShipped, 3);
  assertEquals(Number(out[0].ItemPrice.Amount).toFixed(2), "23.67");
  assertEquals(Number(out[0].ItemTax.Amount).toFixed(2), "1.41");
  // Identity follows the larger line.
  assertEquals(out[0].OrderItemId, "169335557996641");
  assertEquals(out[0].__mergedItemIds.length, 2);
});

Deno.test("does not mutate the caller's array", () => {
  const input = structuredClone(REAL_ORDER);
  mergeOrderItemsByAsin(input);
  assertEquals(input.length, 2);
  assertEquals(input[0].QuantityOrdered, 2);
  assertEquals(input[0].ItemPrice.Amount, "15.78");
});

Deno.test("different ASINs on one order are left alone", () => {
  const out = mergeOrderItemsByAsin([
    { ASIN: "B000AAA111", QuantityOrdered: 1, ItemPrice: { Amount: "10.00" } },
    { ASIN: "B000BBB222", QuantityOrdered: 2, ItemPrice: { Amount: "20.00" } },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0].QuantityOrdered, 1);
  assertEquals(out[1].QuantityOrdered, 2);
});

Deno.test("two SKUs of one ASIN merge, because the storage key is the ASIN", () => {
  const out = mergeOrderItemsByAsin([
    { ASIN: "B07FN34L97", SellerSKU: "SKU-SMALL", QuantityOrdered: 1, ItemPrice: { Amount: "7.89" } },
    { ASIN: "B07FN34L97", SellerSKU: "SKU-BIG", QuantityOrdered: 5, ItemPrice: { Amount: "39.45" } },
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].QuantityOrdered, 6);
  assertEquals(Number(out[0].ItemPrice.Amount).toFixed(2), "47.34");
  // The bigger line keeps its identity.
  assertEquals(out[0].SellerSKU, "SKU-BIG");
});

Deno.test("a line with no ASIN is never folded into a real one", () => {
  const out = mergeOrderItemsByAsin([
    { ASIN: "B07FN34L97", QuantityOrdered: 1, ItemPrice: { Amount: "7.89" } },
    { ASIN: "", QuantityOrdered: 9, ItemPrice: { Amount: "99.00" } },
    { QuantityOrdered: 4, ItemPrice: { Amount: "44.00" } },
  ]);
  assertEquals(out.length, 3);
  assertEquals(out[0].QuantityOrdered, 1);
});

Deno.test("single-item and empty orders pass straight through", () => {
  assertEquals(mergeOrderItemsByAsin([]).length, 0);
  assertEquals(mergeOrderItemsByAsin([{ ASIN: "B07FN34L97", QuantityOrdered: 1 }]).length, 1);
  assertEquals(mergeOrderItemsByAsin(null as any).length, 0);
});

Deno.test("a missing quantity counts as one unit, not zero", () => {
  const out = mergeOrderItemsByAsin([
    { ASIN: "B07FN34L97", ItemPrice: { Amount: "7.89" } },
    { ASIN: "B07FN34L97", ItemPrice: { Amount: "7.89" } },
  ]);
  assertEquals(out[0].QuantityOrdered, 2);
  assertEquals(Number(out[0].ItemPrice.Amount).toFixed(2), "15.78");
});

Deno.test("three lines of one ASIN accumulate", () => {
  const out = mergeOrderItemsByAsin([
    { ASIN: "B0X", QuantityOrdered: 1, ItemPrice: { Amount: "5.00" } },
    { ASIN: "B0X", QuantityOrdered: 2, ItemPrice: { Amount: "10.00" } },
    { ASIN: "B0X", QuantityOrdered: 3, ItemPrice: { Amount: "15.00" } },
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].QuantityOrdered, 6);
  assertEquals(Number(out[0].ItemPrice.Amount).toFixed(2), "30.00");
});
