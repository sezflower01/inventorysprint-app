// Phase 2 regression tests: the internal-caller gate on three fan-out
// endpoints.
//
// ── WHY ORDER IS THE THING UNDER TEST ────────────────────────────────────
//
// The defect these guards close was never a missing check -- it was a check
// in the wrong place. sync-sales-orders DOES authenticate, thoroughly, about
// 230 lines below the branch that fans out over every user; that branch
// returns from inside itself, so it never reached the auth block. Reading the
// file top to bottom, every individual part looked right.
//
// A test that only asserts "the guard exists" would therefore have passed
// against the original bug if the guard had been added anywhere in the file.
// So these tests assert POSITION: the gate must sit between the branch
// condition and the query that reads every user's row. That is the property
// that was violated, so that is the property pinned here.
//
// Source-scanning tests follow the convention of
// _tests/audit-section-14/br-fees-usd-storage_test.ts.
//
// ── THE OTHER WAY THIS BREAKS SILENTLY ───────────────────────────────────
//
// sync-sales-orders answers 202 from a thin wrapper and runs the real work in
// the background, rebuilding the Request to do so. If that rebuild ever stops
// copying the incoming headers, the guard stops seeing x-internal-secret and
// refuses the genuine scheduled job -- killing the five-minute sales sync,
// with the only visible symptom a 403 nobody is watching for. Pinned below.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isInternalCaller } from "../../_shared/require-internal.ts";

// ── fixtures ─────────────────────────────────────────────────────────────

const SECRET = "test-internal-sync-secret-0123456789";
const SERVICE_KEY = "test-service-role-key-abcdefghijklmnop";
const ANON_KEY = "test-anon-publishable-key-qrstuvwxyz";

Deno.env.set("INTERNAL_SYNC_SECRET", SECRET);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);

function req(headers: Record<string, string>): Request {
  return new Request("https://example.invalid/", { method: "POST", headers });
}

async function source(fn: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../${fn}/index.ts`, import.meta.url),
  );
}

// ── behaviour of the gate itself ─────────────────────────────────────────

Deno.test("the scheduled job's credential is accepted", () => {
  assert(isInternalCaller(req({ "x-internal-secret": SECRET })));
});

Deno.test("a service-role bearer is accepted, for fan-out between functions", () => {
  assert(isInternalCaller(req({ Authorization: `Bearer ${SERVICE_KEY}` })));
});

Deno.test("THE CASE THAT MATTERED: the publishable key alone is refused", () => {
  // This key ships in the browser bundle, so it is public. The gateway
  // accepts it, which is exactly why the function has to not.
  assertEquals(isInternalCaller(req({ Authorization: `Bearer ${ANON_KEY}` })), false);
  assertEquals(isInternalCaller(req({ apikey: ANON_KEY })), false);
});

Deno.test("a bearer AND the public key together are still refused", () => {
  assertEquals(
    isInternalCaller(req({ Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY })),
    false,
  );
});

Deno.test("no credential at all is refused", () => {
  assertEquals(isInternalCaller(req({})), false);
});

Deno.test("a wrong secret is refused, and an empty one does not pass as a match", () => {
  assertEquals(isInternalCaller(req({ "x-internal-secret": "nope" })), false);
  assertEquals(isInternalCaller(req({ "x-internal-secret": "" })), false);
});

Deno.test("the real job's shape -- bearer for the gateway, secret for us -- is accepted", () => {
  // Exactly what migration 20261112230000 makes the cron send: a bearer that
  // only satisfies the gateway, plus the credential that actually authorises.
  assert(isInternalCaller(req({
    Authorization: `Bearer ${ANON_KEY}`,
    "x-internal-secret": SECRET,
  })));
});

// ── position of the gate: sync-sales-orders ──────────────────────────────

Deno.test("sync-sales-orders: the gate sits between the branch and the all-users query", async () => {
  const src = await source("sync-sales-orders");

  const branch = src.indexOf("if (isAutomatedCall) {");
  const gate = src.indexOf("isInternalCaller(req)", branch);
  const fanout = src.indexOf("from('seller_authorizations')", branch);

  assert(branch > 0, "the all-users branch should still exist");
  assert(gate > 0, "no isInternalCaller gate found after the branch");
  assert(fanout > 0, "the all-users query should still exist");

  assert(
    gate < fanout,
    "the gate must come BEFORE the query that reads every user's row -- " +
      "a gate after it has already leaked the work it was meant to prevent",
  );
  assert(gate > branch, "the gate belongs inside the all-users branch");
});

Deno.test("sync-sales-orders: the user-facing path is NOT gated by this", async () => {
  const src = await source("sync-sales-orders");

  // The browser calls this function with a user JWT and no internal secret.
  // If the gate had been placed at the top of the handler instead of inside
  // the branch, every signed-in user's sync would break. The user path's own
  // authentication must still be there, and must still come after the branch.
  const branch = src.indexOf("if (isAutomatedCall) {");
  const getUser = src.indexOf("auth.getUser(", branch);

  assert(getUser > 0, "the user path's own authentication has gone missing");

  const handler = src.indexOf("async function handleSyncRequest");
  const firstGate = src.indexOf("isInternalCaller(req)");
  assert(
    firstGate > branch && firstGate > handler,
    "isInternalCaller must not gate the whole handler, only the all-users branch",
  );
});

Deno.test("sync-sales-orders: the 202 wrapper still forwards request headers", async () => {
  const src = await source("sync-sales-orders");

  // The wrapper rebuilds the Request so the work can continue in the
  // background past the 150s idle timeout. The gate reads headers off that
  // rebuilt object. Drop the copy and the genuine cron is refused.
  const buildReq = src.indexOf("const buildReq");
  assert(buildReq > 0, "the request rebuild has been renamed or removed");

  const window = src.slice(buildReq, buildReq + 400);
  assert(
    /headers:\s*req\.headers/.test(window),
    "buildReq() must copy req.headers, or the internal-caller gate cannot " +
      "see x-internal-secret and will refuse the real scheduled job",
  );
});

// ── position of the gate: the two cron-only fan-outs ─────────────────────

for (const fn of ["auto-sync-dispositions-daily", "auto-sync-settlements-weekly"]) {
  Deno.test(`${fn}: the gate precedes the all-users query`, async () => {
    const src = await source(fn);

    const gate = src.indexOf("isInternalCaller(req)");
    const fanout = src.indexOf("from('seller_authorizations')");

    assert(gate > 0, `${fn} has no isInternalCaller gate`);
    assert(fanout > 0, `${fn} no longer reads seller_authorizations`);
    assert(
      gate < fanout,
      `${fn}: the gate must come before the query that reads every user's row`,
    );
  });

  Deno.test(`${fn}: the gate is reached on the very first request`, async () => {
    const src = await source(fn);

    // These have no user-facing path, so the gate belongs immediately after
    // the CORS preflight -- before any work, any query, any await.
    const serveAt = src.indexOf("serve(async (req)");
    const gate = src.indexOf("isInternalCaller(req)", serveAt);
    const body = src.slice(serveAt, gate);

    assert(gate > 0, `${fn}: no gate found inside the handler`);
    assert(
      !/\bawait\b/.test(body),
      `${fn}: something is awaited before the caller is checked -- the gate ` +
        `must be the first thing after the OPTIONS reply`,
    );
  });

  Deno.test(`${fn}: imports the shared gate rather than its own copy`, async () => {
    const src = await source(fn);
    assert(
      /from\s+["']\.\.\/_shared\/require-internal\.ts["']/.test(src),
      `${fn}: must import the shared gate, so there is one definition of ` +
        `"internal caller" and not three that can drift`,
    );
  });
}

Deno.test("sync-sales-orders imports the shared gate too", async () => {
  const src = await source("sync-sales-orders");
  assert(
    /from\s+['"]\.\.\/_shared\/require-internal\.ts['"]/.test(src),
    "sync-sales-orders must import the shared gate",
  );
});
