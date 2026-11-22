/**
 * Disabling "stuck" repricer assignments — the write behind the Stuck
 * Assignments panel's "Fix All" button.
 *
 * ── WHY THIS LEFT THE COMPONENT ──────────────────────────────────────────
 *
 * The filter it builds decides which listings get switched off, and it was
 * wrong in a way no one could see from the screen. It read:
 *
 *     .eq("asin", r.asin).eq("marketplace", r.marketplace).eq("is_enabled", true)
 *
 * with NO sku. repricer_assignments has no unique constraint on (asin, sku),
 * and a seller may legitimately list one ASIN as both FBA and FBM — two real
 * listings with two independent Buy Box competitions. So one stuck row could
 * disable every other SKU on the same ASIN, including a sibling that was in
 * stock and pricing correctly. The panel listed one row and turned off two.
 *
 * A filter that decides what to switch off is worth a test, and a filter
 * built inline inside a click handler cannot have one. That is the whole
 * reason this is a module.
 *
 * user_id is deliberately NOT in the filter: this runs on the browser client,
 * where RLS scopes every write to auth.uid(). Adding it would be belt-and-
 * braces, but omitting it is not the bug here.
 */

/** One row the panel is proposing to disable. */
export interface StuckTarget {
  asin: string;
  sku: string;
  marketplace: string;
}

export interface StuckDisableFailure {
  asin: string;
  sku: string;
  marketplace: string;
  message: string;
}

export interface StuckDisableOutcome {
  attempted: number;
  disabled: number;
  failures: StuckDisableFailure[];
}

type UpdateResult = { error: { message: string } | null };

/** A PostgREST update chain, narrowed to what this module uses. */
export interface EqChain extends PromiseLike<UpdateResult> {
  eq(column: string, value: unknown): EqChain;
}

export interface StuckDisableClient {
  from(table: string): { update(patch: Record<string, unknown>): EqChain };
}

export const STUCK_DISABLE_REASON = "Stuck assignments panel: bulk fix";

/**
 * Disable exactly the listings passed in — one (asin, sku, marketplace) each.
 *
 * Returns what actually happened rather than assuming success. The previous
 * inline version awaited each update WITHOUT reading `error`, then reported
 * `Disabled ${rows.length}` regardless, so a write that was rejected still
 * showed as a fixed listing.
 */
export async function disableStuckAssignments(
  client: StuckDisableClient,
  rows: StuckTarget[],
  nowIso: () => string = () => new Date().toISOString(),
): Promise<StuckDisableOutcome> {
  const outcome: StuckDisableOutcome = { attempted: rows.length, disabled: 0, failures: [] };
  if (rows.length === 0) return outcome;

  const stamp = nowIso();

  for (const r of rows) {
    const { error } = await client
      .from("repricer_assignments")
      .update({
        is_enabled: false,
        manual_paused: false,
        last_disabled_by: "user",
        last_disabled_reason: STUCK_DISABLE_REASON,
        last_disabled_at: stamp,
      })
      .eq("asin", r.asin)
      // THE FIX. Without this one line the update matches every SKU on the
      // ASIN, so an in-stock sibling listing is disabled alongside the stuck
      // one.
      .eq("sku", r.sku)
      .eq("marketplace", r.marketplace)
      // Only rows that are actually on: re-disabling an already-disabled row
      // would overwrite whatever reason it carried.
      .eq("is_enabled", true);

    if (error) {
      outcome.failures.push({ ...r, message: error.message });
      continue;
    }
    outcome.disabled++;
  }

  return outcome;
}
