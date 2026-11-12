/**
 * Turning a 409 from the operator-credential guard into something a person can
 * act on.
 *
 * ── WHY A HELPER AND NOT AN inline CHECK ─────────────────────────────────
 *
 * supabase-js does NOT give you the body of a non-2xx edge-function response
 * on the error object. `error.message` is the fixed string
 * "Edge Function returned a non-2xx status code" for every failure, whatever
 * the function actually said. The real body lives on
 * `FunctionsHttpError.context`, which is a `Response` that has to be awaited --
 * and can only be read ONCE, so a caller that reads it twice gets an empty
 * body the second time.
 *
 * So every call site that wants the guard's message has to do the same
 * four-step dance, and three of the four doing it slightly differently is how
 * the user ends up seeing "non-2xx status code" on one screen and the right
 * sentence on another. One helper, used everywhere.
 *
 * The contract is the CODE, not the status. `supabase/functions/_shared/
 * operator-credential-guard.ts` returns 409 with
 * `{ error, code: 'AMAZON_NOT_CONNECTED', amazonConnected: false }`, and the
 * code is what callers branch on -- a status can be changed by a proxy or
 * reused for something else, a code cannot drift silently.
 */

export const AMAZON_NOT_CONNECTED = "AMAZON_NOT_CONNECTED";

/**
 * Shown when the guard refuses. Deliberately not phrased as a failure: nothing
 * is broken and nothing is forbidden, an account simply is not connected.
 */
export const AMAZON_CONNECT_MESSAGE =
  "Connect your Amazon seller account to use this feature.";

export interface FunctionErrorBody {
  error?: string;
  code?: string;
  amazonConnected?: boolean;
}

/**
 * Read the JSON body out of a supabase-js functions error.
 *
 * Returns {} for anything it cannot read -- a network failure, an HTML error
 * page from a proxy, a body already consumed. Never throws: a helper used in
 * an error path must not be able to replace one error with another.
 */
export async function readFunctionErrorBody(err: unknown): Promise<FunctionErrorBody> {
  try {
    const ctx = (err as { context?: unknown })?.context;
    if (!ctx) return {};
    // FunctionsHttpError.context is a Response in supabase-js v2.
    if (typeof (ctx as Response).json === "function") {
      // clone() so a caller that also inspects the response still can -- a
      // Response body is a one-shot stream.
      const res = ctx as Response;
      const source = typeof res.clone === "function" ? res.clone() : res;
      return (await source.json()) as FunctionErrorBody;
    }
    // Some paths hand back an already-parsed object.
    if (typeof ctx === "object") return ctx as FunctionErrorBody;
    return {};
  } catch {
    return {};
  }
}

/**
 * True when this failure is "the signed-in user has no Amazon connection".
 *
 * Accepts either a thrown supabase error OR a 200-with-error-body payload,
 * because the codebase has both shapes: CreatedListings.tsx checks
 * `data?.error` separately from `error`, and a function that returns 200 with
 * an error field would otherwise slip past.
 */
export async function isAmazonNotConnected(errOrData: unknown): Promise<boolean> {
  const direct = (errOrData as FunctionErrorBody | null)?.code;
  if (direct === AMAZON_NOT_CONNECTED) return true;
  const body = await readFunctionErrorBody(errOrData);
  return body.code === AMAZON_NOT_CONNECTED;
}

/**
 * The message to show for a failed edge-function call: the guard's own
 * sentence when that is what happened, otherwise the best available text.
 *
 * `fallback` is what the call site would have shown anyway, so adopting this
 * helper never makes an unrelated error less informative.
 */
export async function functionErrorMessage(
  err: unknown,
  fallback = "Request failed",
): Promise<string> {
  const body = await readFunctionErrorBody(err);
  if (body.code === AMAZON_NOT_CONNECTED) {
    return body.error || AMAZON_CONNECT_MESSAGE;
  }
  if (body.error) return body.error;
  const msg = (err as { message?: string })?.message;
  // Suppress the one string supabase-js substitutes for every HTTP failure --
  // it tells the user nothing and hides that we had a real body available.
  if (msg && !/non-2xx status code/i.test(msg)) return msg;
  return fallback;
}
