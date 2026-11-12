// Run with:
//   deno test --allow-env supabase/functions/_shared/internal-call-auth_test.ts
//
// The property: a `user_id` in a request body may only be honoured for a caller
// that proved it is the machine. A signed-in user is not a machine, and must
// only ever act as themselves.
//
// Both scheduled-job proofs are covered, because this project's crons use both
// and dropping either kills real jobs: pg_cron sends x-internal-secret with no
// Authorization header, while an edge function calling another sends the
// service-role key as a bearer.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyInternalCall,
  resolveActingUser,
  requireInternalCall,
} from "./internal-call-auth.ts";

const SECRET = "s3cret-internal-sync-value";
const SERVICE_KEY = "service-role-key-aaaaaaaaaaaaaaaaaaaa";
const CORS = { "Access-Control-Allow-Origin": "*" };

const OPERATOR = "020dd71f-78ce-4bc2-9117-dc997c533ab9";
const OTHER = "e790054c-aaaa-bbbb-cccc-dddddddddddd";

function withEnv(fn: () => void | Promise<void>) {
  Deno.env.set("INTERNAL_SYNC_SECRET", SECRET);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  try {
    return fn();
  } finally {
    Deno.env.delete("INTERNAL_SYNC_SECRET");
    Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  }
}

const req = (headers: Record<string, string>) =>
  new Request("https://example.test/fn", { method: "POST", headers });

Deno.test("pg_cron's header is accepted (x-internal-secret, no bearer)", () => {
  withEnv(() => {
    const r = classifyInternalCall(req({ "x-internal-secret": SECRET }));
    assertEquals(r.isInternal, true);
    assertEquals(r.via, "internal_secret");
  });
});

Deno.test("a function-to-function service-role bearer is accepted", () => {
  withEnv(() => {
    const r = classifyInternalCall(req({ Authorization: `Bearer ${SERVICE_KEY}` }));
    assertEquals(r.isInternal, true);
    assertEquals(r.via, "service_role");
  });
});

Deno.test("a user JWT is NOT internal, however valid it looks", () => {
  withEnv(() => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.signature";
    assertEquals(classifyInternalCall(req({ Authorization: `Bearer ${jwt}` })).isInternal, false);
  });
});

Deno.test("a wrong or partial secret is rejected", () => {
  withEnv(() => {
    for (const v of ["", "wrong", SECRET.slice(0, -1), SECRET + "x", SECRET.toUpperCase()]) {
      assertEquals(classifyInternalCall(req({ "x-internal-secret": v })).isInternal, false,
        `accepted ${JSON.stringify(v)}`);
    }
  });
});

Deno.test("no headers at all is rejected", () => {
  withEnv(() => {
    assertEquals(classifyInternalCall(req({})).isInternal, false);
  });
});

Deno.test("an UNSET secret cannot be satisfied by an empty header", () => {
  // The classic failure: Deno.env.get() returns undefined, the provided header
  // is "", and `"" === ""` would let anyone in. Fails closed instead.
  Deno.env.delete("INTERNAL_SYNC_SECRET");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  assertEquals(classifyInternalCall(req({ "x-internal-secret": "" })).isInternal, false);
  assertEquals(classifyInternalCall(req({ Authorization: "Bearer " })).isInternal, false);
  assertEquals(classifyInternalCall(req({})).isInternal, false);
});

Deno.test("THE RULE: a body user_id cannot override a JWT", () => {
  withEnv(() => {
    const notInternal = classifyInternalCall(req({ Authorization: "Bearer a.user.jwt" }));
    const acting = resolveActingUser(notInternal, OPERATOR, OTHER);
    assertEquals(acting.userId, OTHER, "the body overrode the authenticated user");
    assertEquals(acting.source, "jwt");
  });
});

Deno.test("an internal caller MAY act as the user it names", () => {
  withEnv(() => {
    const internal = classifyInternalCall(req({ "x-internal-secret": SECRET }));
    const acting = resolveActingUser(internal, OTHER, null);
    assertEquals(acting.userId, OTHER);
    assertEquals(acting.source, "body_internal");
  });
});

Deno.test("a user sending its OWN id alongside its JWT still acts as itself", () => {
  // Not an attack, and must not be an error -- it would break callers for no
  // safety gain. The body is simply ignored.
  withEnv(() => {
    const notInternal = classifyInternalCall(req({ Authorization: "Bearer a.user.jwt" }));
    assertEquals(resolveActingUser(notInternal, OTHER, OTHER).userId, OTHER);
  });
});

Deno.test("no user and no internal proof resolves to nobody", () => {
  withEnv(() => {
    const r = resolveActingUser(classifyInternalCall(req({})), null, null);
    assertEquals(r.userId, null);
    assertEquals(r.source, "none");
  });
});

Deno.test("requireInternalCall: cron passes, everyone else gets a bare 401", async () => {
  await withEnv(async () => {
    assertEquals(requireInternalCall(req({ "x-internal-secret": SECRET }), CORS, "t"), null);
    assertEquals(requireInternalCall(req({ Authorization: `Bearer ${SERVICE_KEY}` }), CORS, "t"), null);

    const refusal = requireInternalCall(req({}), CORS, "t");
    assert(refusal instanceof Response);
    assertEquals(refusal!.status, 401);
    assertEquals(refusal!.headers.get("Access-Control-Allow-Origin"), "*");
    const body = await refusal!.json();
    // Deliberately uninformative: an endpoint that names the credential it
    // wanted is helping the wrong reader.
    assertEquals(body, { error: "Unauthorized" });
    assertEquals(Object.keys(body).length, 1);
  });
});

Deno.test("the refusal body never names a credential or env var", async () => {
  await withEnv(async () => {
    const text = await requireInternalCall(req({}), CORS, "t")!.text();
    for (const leak of ["internal", "secret", "service", "role", "bearer", "jwt", "INTERNAL_SYNC"]) {
      assert(!text.toLowerCase().includes(leak.toLowerCase()), `refusal mentioned "${leak}"`);
    }
  });
});
