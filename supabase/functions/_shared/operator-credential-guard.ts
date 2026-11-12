// May THIS caller use the operator's own Amazon credentials?
//
// ── THE BUG THIS CLOSES ───────────────────────────────────────────────────
//
// Fifteen edge functions resolve an SP-API token as, in effect:
//
//     const refreshToken = userAuth?.refresh_token
//       || Deno.env.get('SPAPI_REFRESH_TOKEN');
//
// and check-fba-listing-eligibility does the same for seller_id, with the
// comment "else env default". The env values are the ACCOUNT OPERATOR's real
// Amazon seller credentials. So a signed-in user with no SP-API connection of
// their own does not get an error -- they get answers computed against the
// operator's Amazon account, silently:
//
//   * /listings/2021-08-01/restrictions returns whether the OPERATOR is gated
//     on an ASIN. The user reads "you can sell this" from someone else's brand
//     approvals, and also learns which brands the operator is ungated in.
//   * /products/fees/v0/.../feesEstimate is getMyFeesEstimate -- the
//     operator's fee schedule, not theirs.
//   * /fba/inventory/v1/summaries returns the operator's stock (only when a
//     SKU is supplied, so it needs a guess, but it is reachable).
//   * create-amazon-listing WRITES. Under the operator's token a non-owner
//     could create a listing in the operator's Seller Central.
//
// Measured 2026-11-12 on this project: 3 accounts, and only the operator has
// SP-API (4 marketplaces). The other two have none -- and one of them already
// holds personalhour:view, which is what fetch-listing-snapshot gates on, so
// it could reach that path today. Nobody has yet: all 4,796 eligibility
// lookups on record belong to the operator. This is a door standing open, not
// a leak in progress.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// The operator's credentials may be used only by the operator, or by the
// machine acting for them:
//
//   1. an INTERNAL caller (pg_cron with x-internal-secret, or a service-role
//      bearer) -- these run as the operator by definition and are the reason
//      the env fallback exists at all. Scheduled syncs must keep working.
//   2. the operator themselves, identified by SPAPI_OWNER_USER_ID when that
//      secret is set, otherwise by the `admin` role.
//
// Anyone else gets AMAZON_NOT_CONNECTED and is asked to connect their own
// account. The user's OWN token is never affected: callers try that first and
// only consult this guard when there isn't one.
//
// ── WHY THE ADMIN ROLE, AND WHY IT IS THE WEAKER BRANCH ───────────────────
//
// `admin` is a proxy for "owns the operator credentials", and on this project
// it is exact: one admin, who is the operator. It is a proxy nonetheless --
// granting someone admin would hand them the operator's Amazon account as a
// side effect, which is not what granting admin is supposed to mean. So
// SPAPI_OWNER_USER_ID is checked FIRST and wins outright when set, and setting
// it is the durable fix. The role branch exists so this guard can ship without
// waiting on a secret being added, and it is logged distinctly so you can see
// which branch allowed a call.
/**
 * The minimal shape this guard needs, declared STRUCTURALLY rather than
 * imported from supabase-js.
 *
 * Importing `SupabaseClient` from a pinned version made every call site fail
 * to typecheck: the functions import 2.49.4 while this file named 2.45.0, and
 * TypeScript treats the two `SupabaseClient` classes as unrelated types even
 * though they are identical at runtime. Pinning the same version here would
 * only move the problem to the next function that upgrades. A structural type
 * works against any version, and the guard's own behaviour is pinned by
 * operator-credential-guard_test.ts rather than by the client's type.
 */
// deno-lint-ignore no-explicit-any
export type RoleLookupClient = { from: (table: string) => any };

export type CredentialReason =
  | "internal_caller"
  | "operator_by_env_id"
  | "operator_by_admin_role"
  | "not_connected";

export interface OperatorCredentialDecision {
  allowed: boolean;
  reason: CredentialReason;
  /** Machine-readable code for the client. Present only when denied. */
  code?: "AMAZON_NOT_CONNECTED";
  message?: string;
}

export interface OperatorCredentialOptions {
  /** The signed-in user, or null for an unauthenticated internal call. */
  userId: string | null;
  /**
   * True when the request arrived with a valid x-internal-secret or a
   * service-role bearer. The CALLER decides this -- every function detects it
   * differently and this module must not guess. Defaulting to false means a
   * function that forgets to pass it fails CLOSED.
   */
  internal?: boolean;
  /** Function name, for the log line only. */
  fn?: string;
}

/**
 * Decide whether the operator's env credentials may serve this request.
 *
 * Call it ONLY after the user's own token has been looked up and found
 * missing. Never pass it a user's own token decision to make.
 */
export async function mayUseOperatorCredentials(
  supabase: RoleLookupClient,
  opts: OperatorCredentialOptions,
): Promise<OperatorCredentialDecision> {
  const fn = opts.fn ?? "unknown";

  if (opts.internal === true) {
    return { allowed: true, reason: "internal_caller" };
  }

  // No user and not internal: there is nobody to attribute the call to, so
  // there is no basis for lending the operator's account. Fails closed.
  if (!opts.userId) {
    return denied("no authenticated user");
  }

  const ownerId = Deno.env.get("SPAPI_OWNER_USER_ID");
  if (ownerId && ownerId.trim()) {
    if (ownerId.trim() === opts.userId) {
      return { allowed: true, reason: "operator_by_env_id" };
    }
    // SPAPI_OWNER_USER_ID is set and does not match. That is a definitive no:
    // the operator has named themselves explicitly, so the admin-role proxy
    // below must not be able to widen it again.
    console.log(
      `[operator-credential-guard] ${fn}: denied user=${opts.userId} ` +
        `(SPAPI_OWNER_USER_ID is set and does not match)`,
    );
    return denied("this account has no Amazon connection");
  }

  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", opts.userId)
    .eq("role", "admin")
    .maybeSingle();

  if (error) {
    // A failed role lookup must not become an accidental grant.
    console.warn(
      `[operator-credential-guard] ${fn}: role lookup failed, denying: ${error.message}`,
    );
    return denied("could not verify account permissions");
  }

  if (data) {
    console.log(
      `[operator-credential-guard] ${fn}: allowed user=${opts.userId} by ADMIN ROLE ` +
        `(set SPAPI_OWNER_USER_ID to stop relying on this proxy)`,
    );
    return { allowed: true, reason: "operator_by_admin_role" };
  }

  console.log(
    `[operator-credential-guard] ${fn}: denied user=${opts.userId} -- no SP-API ` +
      `connection of their own, and not the operator`,
  );
  return denied("this account has no Amazon connection");
}

/**
 * The same question, asked of a FAN-OUT caller -- and the answer is stricter.
 *
 * ── WHY A SECOND ENTRY POINT RATHER THAN A FLAG ──────────────────────────
 *
 * mayUseOperatorCredentials() treats an internal caller as trusted, and for
 * the interactive functions that is right: a service-role call there means
 * "another edge function is doing this on the operator's behalf", with the
 * operator being the only user in play.
 *
 * It is exactly WRONG for the sync family. Those functions are invoked by a
 * scheduled job that loops over users and names each one in the body, so the
 * caller is internal on every single iteration -- including the iterations
 * for accounts that have never connected anything. Passing `internal: true`
 * there would make the guard return `allowed` for every user in the system,
 * which is the behaviour being fixed, reached by a different road.
 *
 * So this variant does not take `internal` at all. It cannot be passed, so it
 * cannot be passed by mistake. The only question it asks is:
 *
 *      is the user this request is ACTING AS the operator?
 *
 * A trusted caller acting for somebody else is still somebody else.
 *
 * ── WHAT THIS PREVENTS, CONCRETELY ───────────────────────────────────────
 *
 * A new account signs up; the OAuth callback fires a background inventory
 * sync for it; the account has no credentials of its own yet; the function
 * falls back to the operator's token and writes the OPERATOR's FBA catalogue
 * under the new user_id. Every step looks reasonable on its own.
 */
export async function mayActOnOperatorCredentials(
  supabase: RoleLookupClient,
  opts: { actingUserId: string | null; fn?: string },
): Promise<OperatorCredentialDecision> {
  const fn = opts.fn ?? "unknown";

  if (!opts.actingUserId) {
    console.log(`[operator-credential-guard] ${fn}: denied -- no acting user`);
    return denied("no acting user");
  }

  const ownerId = Deno.env.get("SPAPI_OWNER_USER_ID");
  if (ownerId && ownerId.trim()) {
    if (ownerId.trim() === opts.actingUserId) {
      return { allowed: true, reason: "operator_by_env_id" };
    }
    console.log(
      `[operator-credential-guard] ${fn}: denied acting_user=${opts.actingUserId} ` +
        `(SPAPI_OWNER_USER_ID is set and does not match)`,
    );
    return denied("this account has no Amazon connection");
  }

  // No explicit owner configured: fall back to the admin-role proxy, exactly
  // as mayUseOperatorCredentials does, so behaviour does not change the day
  // somebody unsets the variable.
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", opts.actingUserId)
    .eq("role", "admin")
    .maybeSingle();

  if (error) {
    console.warn(
      `[operator-credential-guard] ${fn}: role lookup failed, denying: ${error.message}`,
    );
    return denied("could not verify account permissions");
  }

  if (data) {
    console.log(
      `[operator-credential-guard] ${fn}: allowed acting_user=${opts.actingUserId} ` +
        `by ADMIN ROLE (set SPAPI_OWNER_USER_ID to stop relying on this proxy)`,
    );
    return { allowed: true, reason: "operator_by_admin_role" };
  }

  console.log(
    `[operator-credential-guard] ${fn}: denied acting_user=${opts.actingUserId} ` +
      `-- no SP-API connection of their own, and not the operator`,
  );
  return denied("this account has no Amazon connection");
}

function denied(detail: string): OperatorCredentialDecision {
  return {
    allowed: false,
    reason: "not_connected",
    code: "AMAZON_NOT_CONNECTED",
    // Written for the person who will read it on screen. It must not imply
    // the product is unavailable, only that this account is not connected.
    message:
      "Connect your Amazon seller account to use this feature. " +
      `(${detail})`,
  };
}

/**
 * The response to return when the guard denies a request.
 *
 * 409 rather than 403: nothing is forbidden, a precondition is simply not met,
 * and the client can fix it by connecting an account. 403 would read as "you
 * are not allowed" and send the user looking for a permission they do not
 * need. Clients should branch on `code === 'AMAZON_NOT_CONNECTED'` rather
 * than on the status, which is the stable contract.
 */
export function amazonNotConnectedResponse(
  decision: OperatorCredentialDecision,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: decision.message ?? "Amazon account not connected",
      code: decision.code ?? "AMAZON_NOT_CONNECTED",
      amazonConnected: false,
    }),
    { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
