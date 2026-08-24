/**
 * Realtime channel naming contract.
 *
 * Supabase Realtime already enforces RLS on `postgres_changes` events, so a
 * shared channel name does not leak *row content* on any table whose RLS is
 * correctly scoped. The channel name is nonetheless a real concern for two
 * reasons:
 *
 *   1. Defense-in-depth: if RLS on the underlying table ever regresses (a
 *      permissive policy sneaks in, a `user_id` predicate is dropped, etc.),
 *      a shared channel name flips *every* subscribed tab into a leaker.
 *      Scoping the channel name to `user.id` bounds the blast radius.
 *
 *   2. Multi-client CPU contract (see mem://strategy/platform/multi-client-cpu-scaling-v1):
 *      a shared channel name delivers an event to every user's subscribed
 *      tabs (RLS filters *payloads*, not the wake-up). Even filtered-out
 *      events still fire the subscribe machinery and rack up needless
 *      Realtime bill. User-scoped channel names keep the fan-out proportional
 *      to a single account's tabs.
 *
 * The rules below are enforced site-by-site. Any new channel must fit one of
 * the four categories. See `docs/realtime-channels.md` for the full inventory.
 */

/** User-scoped: safest default. Use for anything tenant-owned. */
export function userChannel(prefix: string, userId: string, ...suffix: (string | number | null | undefined)[]): string {
  const tail = suffix.filter((s) => s !== null && s !== undefined && s !== '').join('-');
  return tail ? `${prefix}-${userId}-${tail}` : `${prefix}-${userId}`;
}

/** Session-scoped: safe when the session id is itself a per-user secret (chat sessions). */
export function sessionChannel(prefix: string, sessionId: string): string {
  return `${prefix}-${sessionId}`;
}

/**
 * Shared admin channel: intentionally shared across all admin tabs so that
 * admin dashboards react in unison. Underlying table MUST have an admin-only
 * RLS SELECT policy (`has_role(auth.uid(), 'admin')`). Callers MUST also
 * gate the subscription behind an `isAdmin` check to avoid non-admin clients
 * subscribing (which would be a no-op payload-wise but still holds a socket).
 */
export function sharedAdminChannel(name: string): string {
  return name;
}

/**
 * Global broadcast channel: shared by every client of every account.
 *
 * The rules above exist because `postgres_changes` events carry ROW DATA, so a
 * shared channel name is both a leak risk and a fan-out cost. Neither applies
 * to a `broadcast` channel that carries nothing but a build identifier:
 *
 *   - There is no table behind it, so there is no RLS to regress and no row
 *     content to leak. The entire payload is a git SHA.
 *   - The fan-out is the point. A deploy notification is meaningless unless it
 *     reaches every connected tab.
 *
 * Restricted to broadcast-only, version-style payloads. Do NOT reach for this
 * for anything tenant-owned -- `userChannel` remains the default.
 */
export function globalBroadcastChannel(name: string): string {
  return name;
}
