// Provenance extraction for Amazon AdjustmentEventList items.
//
// Extracted from index.ts purely so it can be tested without a live API call.
// It lives in this folder, not _shared/, on purpose: a _shared/ edit redeploys
// all ~262 edge functions, and this has exactly one caller.
//
// WHAT IT IS FOR. The adjustment writer reads AdjustmentType only to pick a
// branch and then discards it, never reads SellerSKU at all, and truncates
// PostedDate to a calendar day. financial_events_cache therefore could not say
// what a reimbursement was for, which SKU it belonged to, or when it posted --
// raw_event was NULL on all 122,737 rows.
//
// Measured against the live Finances API on 2026-10-22 over 63 adjustment
// items: Amazon sends SellerSKU on EVERY item and leaves ASIN null on every
// one. The writer stores item.ASIN, which is why no reimbursement has ever
// been attributable to a SKU.
//
// This changes no amount and no sign. It only records what was thrown away.

export interface AdjustmentProvenance {
  adjustment_type: string | null;
  seller_sku: string | null;
  quantity: number | null;
  posted_at: string | null;
  raw_event: Record<string, unknown>;
}

/**
 * Pull the provenance fields off one adjustment event/item pair.
 *
 * raw_event keeps the event-level fields plus THIS item, never the whole
 * event: an event can carry many items, and embedding the full
 * AdjustmentItemList on every row would duplicate the entire payload N times
 * for an N-item event. Per-item is lossless for one row and linear in size.
 *
 * Quantity is coerced defensively -- Amazon has sent it as both a number and a
 * numeric string -- and anything non-finite becomes null rather than NaN,
 * which would fail the integer column.
 */
export function adjustmentProvenance(event: unknown, item: unknown): AdjustmentProvenance {
  const e = (event ?? {}) as Record<string, unknown>;
  const i = (item ?? {}) as Record<string, unknown>;

  const rawQty = i.Quantity ?? i.QuantityShipped;
  const qty = Number(rawQty);

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;

  return {
    adjustment_type: str(e.AdjustmentType),
    seller_sku: str(i.SellerSKU),
    quantity: Number.isFinite(qty) ? qty : null,
    posted_at: str(e.PostedDate),
    raw_event: {
      AdjustmentType: e.AdjustmentType ?? null,
      PostedDate: e.PostedDate ?? null,
      AmazonOrderId: e.AmazonOrderId ?? null,
      AdjustmentItem: item ?? null,
    },
  };
}
