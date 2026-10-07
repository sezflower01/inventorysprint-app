/**
 * What to write when Amazon reports a status.
 *
 * ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 *
 * The worker used to write `{ order_status: status }` and nothing else. So
 * when Amazon cancelled an order we recorded order_status='Canceled' and left
 * is_cancelled at false — and is_cancelled is the column half the app filters
 * on. 321 orders sat in that state carrying $7,671.08 of estimated revenue
 * that Live Sales, the period stats blocks and the missing-COGS review all
 * counted as real.
 *
 * The flag is the switch. Measured 2026-10-07 by setting it on those 321:
 * surfaces filtering on is_cancelled alone fell from $36,597.24 to $28,926.16,
 * and surfaces that also checked order_status did not move, because they were
 * already excluding them. So a cancelled order's estimate stops counting as a
 * consequence of the flag — there is no need to clear estimated_price, and
 * clearing it would destroy the record of what the order was worth.
 *
 * Pulled out as a pure function so both directions can be tested without a
 * database or an Amazon account. The round trip matters: an order can be
 * cancelled and then un-cancelled (Amazon reinstates after a failed payment
 * authorisation clears), and a flag that only ever goes one way would strand it
 * out of every report forever.
 */

export const CANCELLED_STATUSES = new Set(["Canceled", "Cancelled"]);

export function isCancelledStatus(status: string | null | undefined): boolean {
  return CANCELLED_STATUSES.has(String(status ?? "").trim());
}

export interface StatusPatch {
  order_status: string;
  is_cancelled: boolean;
  cancelled_at: string | null;
  last_status_sync_at: string;
  status_source: string;
}

/**
 * @param status  what Amazon just said
 * @param now     ISO timestamp, injected so tests are deterministic
 */
export function statusPatch(status: string, now: string): StatusPatch {
  const cancelled = isCancelledStatus(status);
  return {
    order_status: status,
    is_cancelled: cancelled,
    // Set on the way in, cleared on the way out. Leaving a stale cancelled_at
    // on a reinstated order would make it look cancelled to anything reading
    // the timestamp instead of the flag.
    cancelled_at: cancelled ? now : null,
    // Neither of these was written before, which is why "has the sync seen this
    // order" could not be answered from the row.
    last_status_sync_at: now,
    status_source: "amazon_status_sync",
  };
}

/**
 * Does this row need writing at all?
 *
 * The old guard was `.neq("order_status", status)` in the query, which misses
 * the case this whole change is about: order_status already says Canceled and
 * is_cancelled is still false. That row needs the write precisely because the
 * status did NOT change.
 */
export function needsWrite(
  current: { order_status?: string | null; is_cancelled?: boolean | null } | null,
  status: string,
): boolean {
  if (!current) return false;
  if (String(current.order_status ?? "") !== status) return true;
  return Boolean(current.is_cancelled ?? false) !== isCancelledStatus(status);
}
