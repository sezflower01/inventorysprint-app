// Run with:
//   deno test --allow-env supabase/functions/_shared/operator-credential-guard_test.ts
//
// The property under test is the one the seller asked for: a user with no
// Amazon connection must never receive answers computed from the operator's
// account. Every branch that could hand those credentials out is pinned here,
// including the failure modes -- a role lookup that errors, and a missing
// user -- because a guard that fails OPEN is worse than no guard, since it
// looks like protection.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mayUseOperatorCredentials,
  amazonNotConnectedResponse,
} from "./operator-credential-guard.ts";

/** Minimal stand-in for the one query the guard makes. */
function stubClient(opts: { isAdmin?: boolean; fail?: string } = {}) {
  let calls = 0;
  const client = {
    from(table: string) {
      assertEquals(table, "user_roles", "the guard queried an unexpected table");
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          calls++;
          if (opts.fail) return Promise.resolve({ data: null, error: { message: opts.fail } });
          return Promise.resolve({ data: opts.isAdmin ? { role: "admin" } : null, error: null });
        },
      };
    },
    get roleLookups() { return calls; },
  };
  // deno-lint-ignore no-explicit-any
  return client as any;
}

const OWNER = "020dd71f-0000-0000-0000-000000000000";
const OTHER = "e790054c-0000-0000-0000-000000000000";

function clearEnv() {
  Deno.env.delete("SPAPI_OWNER_USER_ID");
}

Deno.test("a signed-in user with no connection is DENIED", async () => {
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ isAdmin: false }), {
    userId: OTHER,
    fn: "fetch-listing-snapshot",
  });
  assertEquals(d.allowed, false);
  assertEquals(d.code, "AMAZON_NOT_CONNECTED");
  assert(d.message!.includes("Connect your Amazon seller account"));
});

Deno.test("an internal caller is allowed, so scheduled syncs keep working", async () => {
  clearEnv();
  const client = stubClient({ isAdmin: false });
  const d = await mayUseOperatorCredentials(client, { userId: null, internal: true });
  assertEquals(d.allowed, true);
  assertEquals(d.reason, "internal_caller");
  // Decided without a database round trip: cron paths must not depend on a
  // role lookup that could fail.
  assertEquals(client.roleLookups, 0);
});

Deno.test("internal wins even when a user id is present", async () => {
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ isAdmin: false }), {
    userId: OTHER,
    internal: true,
  });
  assertEquals(d.allowed, true);
  assertEquals(d.reason, "internal_caller");
});

Deno.test("no user and not internal FAILS CLOSED", async () => {
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ isAdmin: true }), { userId: null });
  assertEquals(d.allowed, false);
  assertEquals(d.code, "AMAZON_NOT_CONNECTED");
});

Deno.test("omitting `internal` entirely is treated as NOT internal", async () => {
  // A function that forgets to pass the flag must deny, not allow.
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ isAdmin: false }), { userId: OTHER });
  assertEquals(d.allowed, false);
});

Deno.test("the admin role allows, as the documented proxy for the operator", async () => {
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ isAdmin: true }), { userId: OWNER });
  assertEquals(d.allowed, true);
  assertEquals(d.reason, "operator_by_admin_role");
});

Deno.test("SPAPI_OWNER_USER_ID allows the operator without a role lookup", async () => {
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    const client = stubClient({ isAdmin: false });
    const d = await mayUseOperatorCredentials(client, { userId: OWNER });
    assertEquals(d.allowed, true);
    assertEquals(d.reason, "operator_by_env_id");
    assertEquals(client.roleLookups, 0);
  } finally {
    clearEnv();
  }
});

Deno.test("SPAPI_OWNER_USER_ID set + different user DENIES, even an admin", async () => {
  // The explicit setting must not be widenable by the role proxy. This is the
  // whole reason to prefer the secret.
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    const client = stubClient({ isAdmin: true });
    const d = await mayUseOperatorCredentials(client, { userId: OTHER });
    assertEquals(d.allowed, false);
    assertEquals(d.code, "AMAZON_NOT_CONNECTED");
    assertEquals(client.roleLookups, 0, "the role proxy was consulted anyway");
  } finally {
    clearEnv();
  }
});

Deno.test("whitespace-only SPAPI_OWNER_USER_ID falls through to the role proxy", async () => {
  // An env var set to "" or " " by a deploy script must not deny everyone,
  // nor silently allow -- it should behave as unset.
  Deno.env.set("SPAPI_OWNER_USER_ID", "   ");
  try {
    const d = await mayUseOperatorCredentials(stubClient({ isAdmin: true }), { userId: OWNER });
    assertEquals(d.allowed, true);
    assertEquals(d.reason, "operator_by_admin_role");
  } finally {
    clearEnv();
  }
});

Deno.test("a FAILED role lookup denies -- it never becomes a grant", async () => {
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ fail: "connection reset" }), {
    userId: OWNER,
  });
  assertEquals(d.allowed, false);
  assertEquals(d.code, "AMAZON_NOT_CONNECTED");
});

Deno.test("the denial response is a 409 carrying the machine-readable code", async () => {
  clearEnv();
  const d = await mayUseOperatorCredentials(stubClient({ isAdmin: false }), { userId: OTHER });
  const res = amazonNotConnectedResponse(d, { "Access-Control-Allow-Origin": "*" });
  assertEquals(res.status, 409);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assertEquals(body.code, "AMAZON_NOT_CONNECTED");
  assertEquals(body.amazonConnected, false);
  assert(typeof body.error === "string" && body.error.length > 0);
});
