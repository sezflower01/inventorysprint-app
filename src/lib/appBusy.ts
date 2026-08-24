/**
 * Global "this tab is mid-edit / mid-fetch" registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * AppVersionGate can reload the tab when a new build ships. Reloading a tab
 * whose user is halfway through editing min/max prices, cost, or ROI in the
 * repricer table would silently discard that work -- the fields are local
 * component state until saved, so a reload is indistinguishable from throwing
 * the edits away.
 *
 * AssignmentsTable already solved this for its own 15-minute hard refresh:
 *
 *     if (fetchingPrice.size > 0 || fetchingRoi.size > 0 || ...) {
 *       console.log("[Repricer] 15-min refresh DEFERRED ...");
 *       return;
 *     }
 *
 * That guard is component-local state, so a provider mounted at the app root
 * cannot see it. This module is the smallest bridge: components publish their
 * busy state by key, and the gate reads the aggregate.
 *
 * Deliberately NOT React state. The gate reads it from inside a realtime
 * callback that is not tied to a render, and a stale closure over a useState
 * value is exactly the bug that would make it reload during an edit anyway.
 * A module-level Set is read at call time, always current.
 *
 * Keys are namespaced strings ("repricer:price-fetch") so two components can
 * never clear each other's flag.
 */

const busyKeys = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

/** Mark or clear a busy key. Safe to call on every render. */
export function setAppBusy(key: string, busy: boolean): void {
  const had = busyKeys.has(key);
  if (busy === had) return; // no-op, avoids notify storms
  if (busy) busyKeys.add(key);
  else busyKeys.delete(key);
  notify();
}

/** True when anything in the app has work that a reload would destroy. */
export function isAppBusy(): boolean {
  return busyKeys.size > 0;
}

/** For diagnostics -- what is holding the reload back. */
export function appBusyKeys(): string[] {
  return [...busyKeys];
}

export function subscribeAppBusy(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
