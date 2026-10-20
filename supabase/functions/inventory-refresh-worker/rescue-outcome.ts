// The one place that decides what a rescue-inventory-asin response MEANS.
//
// Extracted from index.ts purely so it can be tested without a live function.
// It lives in this folder rather than _shared/ on purpose: a _shared/ edit
// redeploys all ~262 edge functions, and this logic has exactly one caller.
//
// The distinction it draws is the whole point. rescue-inventory-asin answers
// 200 in two very different situations:
//
//   * it fetched Amazon's numbers and wrote them        -> a real refresh
//   * it decided NOT to write, and says why in
//     `skipped_update_reason`                           -> a decline
//
// Collapsing those two into "success" is what let B00LFXMBKI report 0 units
// for seven weeks while Amazon held 145 and the ASIN sold 52. Every 3-hourly
// queue row was green; none of them had written anything.

export type RescueOutcome =
  | { kind: "written" }
  | { kind: "declined"; reason: string }
  | { kind: "failed"; error: string };

/**
 * Classify a rescue-inventory-asin response.
 *
 * Deliberate choices, each one a failure mode we would otherwise hit:
 *  - A non-2xx is `failed` and keeps the body snippet, because that is what
 *    lands in last_error and is all a future reader gets.
 *  - A 200 whose body will not parse is `written`, NOT `declined`. If the
 *    response shape ever changes, degrading to the old behaviour is
 *    recoverable; silently reclassifying every refresh as a decline would
 *    halt the queue's apparent progress and hide real writes.
 *  - A present-but-blank reason is `written` for the same reason: only an
 *    explicit, non-empty reason counts.
 *  - `update_failed:` / `insert_failed:` are the two reasons that are NOT
 *    declines. rescue reports a genuine Postgres write failure in the same
 *    field, inside a 200 -- so treating every reason as terminal would turn
 *    a real, retryable DB error into a quiet permanent skip, which is the
 *    bug this whole change exists to remove, just one layer down.
 */
export function readRescueOutcome(status: number, body: string): RescueOutcome {
  if (status < 200 || status >= 300) {
    return { kind: "failed", error: `rescue ${status}: ${body.slice(0, 300)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "written" };
  }
  const raw = (parsed as Record<string, unknown> | null)?.skipped_update_reason;
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "written" };
  const reason = raw.trim();
  if (reason.startsWith("update_failed:") || reason.startsWith("insert_failed:")) {
    return { kind: "failed", error: `rescue ${reason}`.slice(0, 300) };
  }
  return { kind: "declined", reason };
}
