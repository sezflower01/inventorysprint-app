/**
 * Collapse repeated lines of the SAME ASIN within one Amazon order.
 *
 * WHY. sales_orders is unique on (user_id, order_id, asin) and carries no
 * order-item column, so two OrderItems for one ASIN cannot both be stored. The
 * Orders API writers loop the items and upsert per item, so the two lines
 * resolve to the same row and the LAST one wins -- its quantity and revenue
 * replace the first line's rather than adding to it.
 *
 * Measured on order 111-8310672-6833058 (2026-09-08):
 *   Amazon  item 169335557996641  qty 2 @ 7.89 = 15.78
 *           item 169229418255161  qty 1 @ 7.89 =  7.89   -> 3 units, 23.67
 *   stored  quantity 1, revenue 7.89
 *   fees    referral 3.54 (15% of 23.67) + FBA 9.03 (3 x 3.01) = 12.57
 *
 * Fees were right for three units and revenue right for one, so the line read
 * as a 159% fee rate and a loss on a product that sold at a profit. That
 * asymmetry is the tell: fees arrive per ORDER, revenue was taken per ITEM.
 *
 * Note the same aggregation ALREADY exists twice in sync-sales-orders -- the
 * financial-events path builds aggregatedByAsin, and the refund path has an
 * explicit "aggregate by ASIN" pass. Only the Orders API path lacked it. Shared
 * here so the fourth writer does not have to rediscover it.
 *
 * Merging by ASIN specifically, not by (ASIN, SKU): the storage key is the
 * ASIN, so two SKUs of one ASIN on one order collide just as surely and must
 * merge too. The surviving line keeps the identity of the largest quantity.
 *
 * Orders spanning several DIFFERENT ASINs are untouched -- the key already
 * separates those correctly.
 */

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

const MONEY_FIELDS = [
  "ItemPrice",
  "ShippingPrice",
  "ItemTax",
  "ShippingTax",
  "PromotionDiscount",
  "ShippingDiscount",
] as const;

function addMoney(target: any, source: any, field: string): void {
  if (!source?.[field]) return;
  if (!target[field]) {
    target[field] = { ...source[field] };
    return;
  }
  target[field].Amount = String(num(target[field].Amount) + num(source[field].Amount));
}

/**
 * Shallow-copy the item, but deep-copy the money sub-objects.
 *
 * `{...item}` alone is not enough and the difference is not cosmetic: the money
 * fields are nested objects, so a shallow copy leaves `ItemPrice` pointing at
 * the CALLER's object, and the accumulate step below then writes through to it.
 * Callers that read the original array again -- several do -- would see a line
 * whose price had silently grown. Caught by the "does not mutate" test, which
 * failed with 31.56 against an expected 15.78: exactly the double-count.
 */
function cloneItem(item: any): any {
  const copy = { ...item };
  for (const field of MONEY_FIELDS) {
    if (copy[field] && typeof copy[field] === "object") copy[field] = { ...copy[field] };
  }
  return copy;
}

export function mergeOrderItemsByAsin(items: any[]): any[] {
  if (!Array.isArray(items) || items.length < 2) return items || [];

  const merged: any[] = [];
  const indexByAsin = new Map<string, number>();
  let mergeCount = 0;

  for (const item of items) {
    const asin = String(item?.ASIN || "").trim();

    // No ASIN means nothing to collide on. Pass it through untouched so an
    // unidentified line is never folded into a real one.
    if (!asin) {
      merged.push(cloneItem(item));
      continue;
    }

    const at = indexByAsin.get(asin);
    if (at === undefined) {
      indexByAsin.set(asin, merged.length);
      merged.push(cloneItem(item));
      continue;
    }

    mergeCount++;
    const existing = merged[at];
    const existingQty = num(existing.QuantityOrdered) || 1;
    const incomingQty = num(item.QuantityOrdered) || 1;

    existing.QuantityOrdered = existingQty + incomingQty;
    if (existing.QuantityShipped != null || item.QuantityShipped != null) {
      existing.QuantityShipped = num(existing.QuantityShipped) + num(item.QuantityShipped);
    }
    for (const field of MONEY_FIELDS) addMoney(existing, item, field);

    // Keep the identity of the bigger line, so a 1-unit add-on does not rename
    // a 20-unit line's SKU.
    if (incomingQty > existingQty) {
      existing.SellerSKU = item.SellerSKU || existing.SellerSKU;
      existing.OrderItemId = item.OrderItemId || existing.OrderItemId;
    }
    existing.Title = existing.Title || item.Title;
    existing.__mergedItemIds = [
      ...(existing.__mergedItemIds || [existing.OrderItemId].filter(Boolean)),
      item.OrderItemId,
    ].filter(Boolean);
  }

  if (mergeCount > 0) {
    console.log(
      `[mergeOrderItemsByAsin] merged ${mergeCount} repeated ASIN line(s); ${items.length} items -> ${merged.length}`,
    );
  }
  return merged;
}
