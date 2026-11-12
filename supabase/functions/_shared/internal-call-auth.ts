// Who is allowed to act as an arbitrary user?
//
// Distinct from operator-credential-guard.ts, and the two are easy to confuse:
//
//   * operator-credential-guard answers "whose AMAZON ACCOUNT may this request
//     use?"
//   * this file answers "which USER may this request act as?"
//
// A request can pass one and fail the other, and the second question is the
// sharper of the two, because acting as another user means writing into their
// rows.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// A `user_id` taken from the REQUEST BODY is only trustworthy if the caller
// proved it is the machine. Two proofs are accepted, because the scheduled
// jobs in this project use both and neither can be dropped:
//
//   * `x-internal-secret` matching INTERNAL_SYNC_SECRET -- what pg_cron sends.
//   * an Authorization bearer equal to SUPABASE_SERVICE_ROLE_KEY -- what an
//     edge function calling another edge function sends.
//
// Anything else -- including a perfectly valid user JWT -- may only act as the
// user that JWT identifies. A signed-in user is not a machine.
//
// ── WHY THIS IS A SHARED HELPER AND NOT TWO INLINE CHECKS ─────────────────
//
// Because it has to be testable. These are request handlers that call
// Deno.serve at module scope, so a test cannot import them without starting a
// server. Putting the decision in a pure function means the rule itself can be
// tested, which is the part worth testing.
//
// ⚠️ Comparisons use a length-checked equality rather than `===` on the raw
// strings. These are shared secrets arriving from the network; a plain compare
// leaks a timing signal about how many leading bytes matched. The cost here is
// a few microseconds.

export type InternalProof = "internal_secret" | "service_role" | null;

export interface InternalCallResult {
  /** True when the caller proved it is the machine. */
  isInternal: boolean;
  /** Which proof succeeded, for logging. */
  via: InternalProof;
}

/** Constant-time string compare. Returns false on any length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Does this request carry machine credentials?
 *
 * Reads only headers, never the body, so it is safe to call before the body is
 * consumed.
 */
export function classifyInternalCall(req: Request): InternalCallResult {
  const expectedSecret = Deno.env.get("INTERNAL_SYNC_SECRET") || "";
  const providedSecret = req.headers.get("x-internal-secret") || "";
  if (expectedSecret && safeEqual(providedSecret, expectedSecret)) {
    return { isInternal: true, via: "internal_secret" };
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (serviceRoleKey && safeEqual(bearer, serviceRoleKey)) {
    return { isInternal: true, via: "service_role" };
  }

  return { isInternal: false, via: null };
}

/**
 * Resolve the user a request may act as.
 *
 * `bodyUserId` is honoured ONLY for an internal caller. For everyone else the
 * authenticated user wins, and a `user_id` in the body is ignored rather than
 * rejected -- a client that sends its own id alongside its own JWT is not
 * attacking anything, and failing that request would break callers for no
 * safety gain. What must never happen is the body OVERRIDING the JWT.
 */
export function resolveActingUser(
  internal: InternalCallResult,
  bodyUserId: string | null | undefined,
  authenticatedUserId: string | null | undefined,
): { userId: string | null; source: "body_internal" | "jwt" | "none" } {
  if (internal.isInternal && bodyUserId) {
    return { userId: String(bodyUserId), source: "body_internal" };
  }
  if (authenticatedUserId) {
    return { userId: String(authenticatedUserId), source: "jwt" };
  }
  return { userId: null, source: "none" };
}

/**
 * For a function that has NO user-facing path at all: refuse anything that is
 * not the machine.
 *
 * Returns a Response to send, or null to continue. 401 with no detail -- an
 * endpoint that explains which credential it wanted is helping the wrong
 * reader.
 */
export function requireInternalCall(
  req: Request,
  corsHeaders: Record<string, string>,
  fn: string,
): Response | null {
  const result = classifyInternalCall(req);
  if (result.isInternal) {
    console.log(`[internal-call-auth] ${fn}: authorized via ${result.via}`);
    return null;
  }
  console.warn(`[internal-call-auth] ${fn}: refused an unauthorized call`);
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
