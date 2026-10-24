// WHERE an Amazon AdjustmentItem's money belongs. ONE implementation.
//
// This is imported by BOTH fetch-profit-loss (the live sync) and
// repull-month-adjustments (the one-month backfill). That is deliberate: the
// backfill must reproduce the sync's classification exactly, and the only way
// to guarantee that is for there to be one copy. A second hand-written chain
// would agree on the day it was written and quietly diverge afterwards -- and
// a backfill that classifies differently from the sync produces months that
// cannot be compared with each other, which defeats the point of backfilling.
//
// It lives in fetch-profit-loss/ rather than _shared/ because a _shared/ edit
// redeploys all ~262 edge functions; a sibling import costs one extra file in
// two bundles.
//
// THE ORDER OF THESE TESTS IS LOAD-BEARING and matches the chain it replaced:
// POSTAGE_BILLING, LIQUIDATION, REVERSAL_REIMBURSEMENT, then the LOST family,
// then the DAMAGE family, FREE_REPLACEMENT, COMPENSATED_CLAWBACK, catch-all.
// Move COMPENSATED_CLAWBACK above the LOST family and nothing breaks; move the
// LOST family above REVERSAL_REIMBURSEMENT and reversals start being filed as
// warehouse losses, because "REVERSAL_REIMBURSEMENT" does not contain "LOST"
// but future Amazon types might.

/**
 * Does this adjustment type / fee reason describe an Amazon-purchased shipping
 * label billed back to the seller?
 *
 * Moved here from fetch-profit-loss/index.ts so the router and the sync share
 * one copy. The sync still uses it for ServiceFeeEventList as well, which is
 * why it is exported rather than kept private.
 */
export function isFbmShippingLabelReason(s: string | undefined | null): boolean {
  if (!s) return false;
  const v = String(s).toLowerCase();
  return (
    v.includes('shippingservice') ||
    v.includes('shippinglabel') ||
    v.includes('buyshipping') ||
    v.includes('buy shipping') ||
    v === 'safe-t' ||
    v.includes('safe-t') ||
    v.includes('postage')
  );
}

/** Columns on financial_events_cache an adjustment can land in. */
export type AdjustmentColumn =
  | "fbm_shipping_label_fee"
  | "liquidations"
  | "reversal_reimbursement"
  | "warehouse_lost"
  | "warehouse_damage"
  | "free_replacement_refund_items"
  | "compensated_clawback"
  | "reimbursements";

export interface AdjustmentRoute {
  /** financial_events_cache.event_type for the row. */
  eventType: "adjustment" | "liquidation";
  column: AdjustmentColumn;
  /** The value to ADD to that column, sign already decided. */
  value: number;
  /** POSTAGE_BILLING uses its own synthetic order-id prefix. */
  postage: boolean;
  /**
   * TRUE only for the final unrecognised-type branch.
   *
   * This exists because `column === 'reimbursements'` is NOT evidence of an
   * unrecognised type: a NEGATIVE WAREHOUSE_LOST or WAREHOUSE_DAMAGE is
   * deliberately routed there too, by a branch that knows exactly what it is
   * looking at. Conflating the two made a gate fire on two perfectly ordinary
   * negative rows (2026-05-04 at -6.83 and 2026-06-03 at -5.78) and report an
   * unmapped AdjustmentType that does not exist.
   *
   * Only this flag separates "Amazon sent a type we have never mapped" from
   * "a mapped type arrived with the opposite sign".
   */
  viaCatchAll: boolean;
}

/**
 * Classify one adjustment item. `null` means write no row at all.
 *
 * `amount` must already be converted to USD and must carry AMAZON'S SIGN.
 * Passing an absolute value here is how clawbacks were invisible for 22
 * months.
 */
export function routeAdjustment(
  adjustmentTypeRaw: unknown,
  amount: number,
): AdjustmentRoute | null {
  const t = String(adjustmentTypeRaw ?? "").toUpperCase();

  // Amazon-purchased postage billed back to the seller. Magnitude, because the
  // column is a fee. Uses the SAME predicate the sync has always used -- it
  // matches six spellings, not just POSTAGE_BILLING, and narrowing it here
  // would have quietly reclassified SAFE-T and Buy Shipping charges.
  if (isFbmShippingLabelReason(t)) {
    return { eventType: "adjustment", column: "fbm_shipping_label_fee", value: Math.abs(amount), postage: true, viaCatchAll: false };
  }

  if (t.includes("LIQUIDATION")) {
    // Only proceeds count; a negative here is the brokerage fee, handled by
    // RemovalShipmentEventList instead.
    return { eventType: "liquidation", column: "liquidations", value: amount > 0 ? amount : 0, postage: false, viaCatchAll: false };
  }

  // Despite the name this arrives POSITIVE -- money TO the seller, what
  // InventoryLab labels CustomerReturn. Measured 2026-10-22 over 63 items:
  // 6 of them, all positive, +$97.46, matching InventoryLab's CustomerReturn
  // total exactly. abs() is therefore a no-op and it is correctly income.
  if (t.includes("REVERSAL_REIMBURSEMENT")) {
    return { eventType: "adjustment", column: "reversal_reimbursement", value: Math.abs(amount), postage: false, viaCatchAll: false };
  }

  if (t.includes("WAREHOUSE_LOST") || t.includes("MISSING_FROM_INBOUND") || t.includes("LOST")) {
    return amount > 0
      ? { eventType: "adjustment", column: "warehouse_lost", value: amount, postage: false, viaCatchAll: false }
      // Negative LOST/DAMAGE into reimbursements is a KNOWN path, not the catch-all.
      : { eventType: "adjustment", column: "reimbursements", value: amount, postage: false, viaCatchAll: false };
  }

  if (t.includes("WAREHOUSE_DAMAGE") || t.includes("DAMAGE")) {
    return amount > 0
      ? { eventType: "adjustment", column: "warehouse_damage", value: amount, postage: false, viaCatchAll: false }
      // Negative LOST/DAMAGE into reimbursements is a KNOWN path, not the catch-all.
      : { eventType: "adjustment", column: "reimbursements", value: amount, postage: false, viaCatchAll: false };
  }

  if (t.includes("FREE_REPLACEMENT")) {
    return { eventType: "adjustment", column: "free_replacement_refund_items", value: amount > 0 ? amount : 0, postage: false, viaCatchAll: false };
  }

  // Amazon reclaiming a reimbursement. Arrives NEGATIVE and is stored verbatim:
  // the sign is the fact. Before this branch existed the type matched nothing
  // and fell to the catch-all's `amount > 0`, which it failed, so no row was
  // ever written -- 0 rows and $0.00 across 22 months while Amazon really was
  // sending them.
  if (t.includes("COMPENSATED_CLAWBACK")) {
    return { eventType: "adjustment", column: "compensated_clawback", value: amount, postage: false, viaCatchAll: false };
  }

  // Everything else, EITHER SIGN. This used to be `amount > 0`, which silently
  // discarded unrecognised negatives -- no row, so nothing downstream could
  // even report them missing. Zero still writes nothing: a row carrying no
  // money is noise.
  if (amount !== 0) {
    // THE ONLY genuine catch-all: the type matched nothing above.
    return { eventType: "adjustment", column: "reimbursements", value: amount, postage: false, viaCatchAll: true };
  }
  return null;
}
