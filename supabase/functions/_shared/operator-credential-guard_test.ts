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
  mayActOnOperatorCredentials,
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


// ══════════════════════════════════════════════════════════════════════════
// mayActOnOperatorCredentials -- the fan-out variant.
//
// These exist because the sync family is driven by a scheduled job that is
// internal on EVERY iteration, including the iterations for accounts that
// have never connected anything. The interactive guard would return
// `allowed` for all of them. The property pinned below is that trust in the
// CALLER confers nothing on the user being acted for.
// ══════════════════════════════════════════════════════════════════════════

Deno.test("fan-out: the operator named by env is allowed", async () => {
  clearEnv();
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    const d = await mayActOnOperatorCredentials(stubClient(), { actingUserId: OWNER, fn: "t" });
    assertEquals(d.allowed, true);
    assertEquals(d.reason, "operator_by_env_id");
  } finally { clearEnv(); }
});

Deno.test("THE BUG: a cron acting for another user is DENIED", async () => {
  // The exact shape of what happened: a trusted internal caller, a real
  // user_id in the body, no credentials of their own. Previously this fell
  // through to the operator's token and wrote the operator's catalogue under
  // that account.
  clearEnv();
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    const d = await mayActOnOperatorCredentials(stubClient(), { actingUserId: OTHER, fn: "t" });
    assertEquals(d.allowed, false);
    assertEquals(d.code, "AMAZON_NOT_CONNECTED");
  } finally { clearEnv(); }
});

Deno.test("fan-out: being an admin still passes when no owner is configured", async () => {
  // Behaviour must not change the day somebody unsets the variable.
  clearEnv();
  const d = await mayActOnOperatorCredentials(stubClient({ isAdmin: true }), {
    actingUserId: OWNER, fn: "t",
  });
  assertEquals(d.allowed, true);
  assertEquals(d.reason, "operator_by_admin_role");
});

Deno.test("fan-out: a non-admin with no owner configured is DENIED", async () => {
  clearEnv();
  const d = await mayActOnOperatorCredentials(stubClient({ isAdmin: false }), {
    actingUserId: OTHER, fn: "t",
  });
  assertEquals(d.allowed, false);
});

Deno.test("fan-out: an explicit owner OUTRANKS the admin role", async () => {
  // Without this, granting somebody the admin role for an unrelated reason
  // would quietly hand them the operator's Amazon account.
  clearEnv();
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    const client = stubClient({ isAdmin: true });
    const d = await mayActOnOperatorCredentials(client, { actingUserId: OTHER, fn: "t" });
    assertEquals(d.allowed, false, "the admin role widened an explicit owner setting");
    assertEquals(client.roleLookups, 0, "it consulted user_roles after a definitive answer");
  } finally { clearEnv(); }
});

Deno.test("fan-out: a null acting user is DENIED", async () => {
  clearEnv();
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    assertEquals(
      (await mayActOnOperatorCredentials(stubClient(), { actingUserId: null, fn: "t" })).allowed,
      false,
    );
  } finally { clearEnv(); }
});

Deno.test("fan-out: a failed role lookup DENIES rather than granting", async () => {
  clearEnv();
  const d = await mayActOnOperatorCredentials(stubClient({ fail: "connection reset" }), {
    actingUserId: OTHER, fn: "t",
  });
  assertEquals(d.allowed, false, "a database error became an accidental grant");
});

Deno.test("fan-out: an empty or whitespace owner setting is not a match", async () => {
  // Deno.env.get() on an unset-but-present variable returns "". If that were
  // compared loosely, every user would match an empty owner id.
  for (const v of ["", "   "]) {
    clearEnv();
    Deno.env.set("SPAPI_OWNER_USER_ID", v);
    try {
      const d = await mayActOnOperatorCredentials(stubClient({ isAdmin: false }), {
        actingUserId: OTHER, fn: "t",
      });
      assertEquals(d.allowed, false, `an owner setting of ${JSON.stringify(v)} allowed a stranger`);
    } finally { clearEnv(); }
  }
});

Deno.test("fan-out: there is NO way to pass internal/trusted to this variant", async () => {
  // The interactive guard short-circuits on `internal: true`. If that option
  // were ever accepted here, a cron -- internal on every iteration -- would
  // be allowed for every user in the system, reintroducing the bug by a
  // different road. Passing it must change nothing.
  clearEnv();
  Deno.env.set("SPAPI_OWNER_USER_ID", OWNER);
  try {
    const sneaky = { actingUserId: OTHER, fn: "t", internal: true } as unknown as {
      actingUserId: string; fn: string;
    };
    assertEquals((await mayActOnOperatorCredentials(stubClient(), sneaky)).allowed, false);

    // ...and the interactive guard really does behave the other way, so the
    // difference between the two is pinned, not assumed.
    const interactive = await mayUseOperatorCredentials(stubClient(), {
      userId: OTHER, internal: true, fn: "t",
    });
    assertEquals(interactive.allowed, true, "the two guards no longer differ as documented");
  } finally { clearEnv(); }
});
