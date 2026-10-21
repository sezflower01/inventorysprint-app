/**
 * Decision logic for the Inventory Valuation privacy gate.
 *
 * Split out of ValuationPrivacyGate.tsx so it can be tested: the repo has
 * Vitest but no jsdom or testing-library, so a React component cannot be
 * rendered in a test, while these functions can. The security-relevant branch
 * is readStoredUnlock's error path -- see below -- and that is exactly the kind
 * of condition that silently inverts during a refactor, so it is pinned by a
 * test rather than left to review.
 *
 * The threat model and the reason the code is a plain constant are documented
 * in ValuationPrivacyGate.tsx. Short version: this stops a glance over your
 * shoulder, not someone with devtools.
 */

/** The reveal code. See the header in ValuationPrivacyGate.tsx. */
export const REVEAL_CODE = "1365";
export const CODE_LENGTH = REVEAL_CODE.length;

/** sessionStorage key, so closing the tab re-locks. */
export const UNLOCK_KEY = "inventory-valuation-revealed";

/** The flag value written on unlock. Anything else must read as locked. */
const UNLOCKED_VALUE = "1";

/**
 * The subset of the Storage API this module uses, so a test can pass a stub
 * that throws the way a private window or blocked site data does.
 */
export interface UnlockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Exact match only. No trimming, no coercion: a four-digit code has no
 * formatting variants worth being lenient about, and leniency here only widens
 * what counts as the secret.
 */
export function isRevealCode(value: unknown): boolean {
  return typeof value === "string" && value === REVEAL_CODE;
}

/**
 * Read the stored unlock, FAILING CLOSED.
 *
 * Every non-exact outcome -- a throw from a private window or blocked site
 * data, a missing key, or any value other than the exact flag -- returns false
 * and keeps the figures hidden. A storage error must never be the thing that
 * reveals them, which is the inverse of the usual "degrade to working"
 * instinct and the reason this is tested.
 */
export function readStoredUnlock(storage: UnlockStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(UNLOCK_KEY) === UNLOCKED_VALUE;
  } catch {
    return false;
  }
}

/**
 * Persist or clear the unlock. Returns whether it stuck, so a caller can tell
 * "the unlock will not survive a navigation" from "it did". A failure here is
 * non-fatal -- the gate still honours the in-memory state for this view.
 */
export function writeStoredUnlock(
  storage: UnlockStorage | null | undefined,
  revealed: boolean,
): boolean {
  if (!storage) return false;
  try {
    if (revealed) storage.setItem(UNLOCK_KEY, UNLOCKED_VALUE);
    else storage.removeItem(UNLOCK_KEY);
    return true;
  } catch {
    return false;
  }
}

/** sessionStorage when it exists, else null. Safe during SSR or in a sandbox. */
export function getUnlockStorage(): UnlockStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Accessing the property itself can throw when site data is blocked.
    return null;
  }
}
