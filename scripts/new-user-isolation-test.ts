#!/usr/bin/env -S deno run --allow-env --allow-net
//
// New-user isolation test.
//
// Creates a real, throwaway account, drives every path that can write rows
// under a user_id, and then asserts that NOTHING belonging to the operator
// appears anywhere under that account. Cleans up after itself.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// A second account on this project once ended up holding 3,820 inventory
// rows, 3,790 of which shared an (asin, sku) with the operator's, plus the
// operator's own FBA barcodes and brand research. Nothing malicious happened:
// a sync ran for an account that had no credentials of its own, fell back to
// the shared ones, and wrote what it found under the new user_id. Every step
// looked reasonable in isolation.
//
// Unit tests pin the guard's decisions. They cannot tell you whether some
// other path -- a trigger, a seed, a function nobody thought about -- still
// does the same thing. Only a real account can, which is why this is a script
// you run against the deployed system rather than a test in the suite.
//
// ── WHY IT IS NOT IN CI ──────────────────────────────────────────────────
//
// It needs the service-role key and it creates and deletes a real user. That
// belongs in the operator's hands, run deliberately after a deploy, not on
// every push with a long-lived secret sitting in a CI environment.
//
// ── USAGE ────────────────────────────────────────────────────────────────
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
//   SUPABASE_ANON_KEY=<anon key> \
//   SPAPI_OWNER_USER_ID=<the operator's user id> \
//   INTERNAL_SYNC_SECRET=<optional: also exercises the scheduled-job path> \
//     deno run --allow-env --allow-net scripts/new-user-isolation-test.ts --confirm
//
// --confirm   required; this creates a real account on a real project
// --keep      do not delete the test account at the end (for inspection)
//
// Nothing is printed that could identify a real user, and no secret is echoed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// ── configuration ────────────────────────────────────────────────────────

const args = new Set(Deno.args);
const KEEP = args.has("--keep");

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v || !v.trim()) {
    console.error(`missing required environment variable: ${name}`);
    Deno.exit(2);
  }
  return v.trim();
}

if (!args.has("--confirm")) {
  console.error(
    "This creates and deletes a real account on a real project.\n" +
      "Re-run with --confirm when you mean it.",
  );
  Deno.exit(2);
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
const OWNER_ID = requireEnv("SPAPI_OWNER_USER_ID");
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SYNC_SECRET")?.trim() || "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── result collection ────────────────────────────────────────────────────

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

// ── the functions that can write under a user_id ─────────────────────────
//
// Every function here either resolves SP-API credentials or writes rows keyed
// by user_id. `body` is the smallest payload each one accepts.
//
// A function is EXPECTED to refuse a user with no Amazon connection. What
// counts as refusing differs: most return 409 with code AMAZON_NOT_CONNECTED,
// some return 400 or 200-with-an-error-body. The assertion below is therefore
// not "status === 409" but the thing that actually matters: no rows appeared.
// The status is reported for information, not as the gate.

const TARGETS: Array<{ fn: string; body: Record<string, unknown> }> = [
  { fn: "sync-amazon-inventory", body: {} },
  { fn: "sync-sales-orders", body: { marketplace: "US", days_back: 1 } },
  { fn: "sync-fbm-label-cost", body: { order_id: "000-0000000-0000000" } },
  { fn: "sync-fbm-cleanup", body: { non_destructive_sync: true } },
  { fn: "bulk-live-verify", body: { mode: "verify", limit: 1, dryRun: true } },
  { fn: "fetch-listing-snapshot", body: { asin: "B000000000", marketplace: "US" } },
  { fn: "check-fba-listing-eligibility", body: { asin: "B000000000" } },
  { fn: "check-product-eligibility", body: { asin: "B000000000" } },
  { fn: "asin-dimensions", body: { asin: "B000000000" } },
];

// ── tables worth checking by natural key ─────────────────────────────────
//
// For these, "a row exists" is not the question -- several tables are seeded
// per account by triggers, so a count alone cannot tell a copy from a default.
// The question is whether a row under the test account MATCHES one of the
// operator's on a key that identifies real catalogue data.

const KEYED: Array<{ table: string; keys: string[] }> = [
  { table: "inventory", keys: ["asin", "sku"] },
  { table: "user_brands", keys: ["brand"] },
  { table: "created_listings", keys: ["asin"] },
  { table: "sales_orders", keys: ["order_id", "asin"] },
  { table: "inventory_history", keys: ["sku"] },
];

async function callAs(fn: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, text: text.slice(0, 300) };
}

/** Every public table carrying a user_id, asked of the database itself. */
async function tablesWithUserId(): Promise<string[]> {
  const { data, error } = await admin.rpc("fn_tables_with_user_id");
  if (!error && Array.isArray(data)) {
    return (data as Array<{ table_name: string }>).map((r) => r.table_name);
  }
  // The helper RPC is optional. Without it, fall back to the keyed list --
  // narrower, and said out loud rather than silently.
  console.log(
    "  note: fn_tables_with_user_id not available; checking only the keyed tables",
  );
  return KEYED.map((k) => k.table);
}

// ── the run ──────────────────────────────────────────────────────────────

const stamp = Date.now();
const email = `isolation-test+${stamp}@example.invalid`;
const password = crypto.randomUUID() + crypto.randomUUID();
let testUserId = "";

console.log("new-user isolation test");
console.log(`  project : ${SUPABASE_URL}`);
console.log(`  account : ${email}`);
console.log("");

try {
  // ── 1. create the account ──────────────────────────────────────────────
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    console.error(`could not create the test account: ${createErr?.message}`);
    Deno.exit(1);
  }
  testUserId = created.user.id;
  console.log(`created test account ${testUserId}`);
  console.log("");

  if (testUserId === OWNER_ID) {
    console.error("refusing to continue: the test account IS the operator");
    Deno.exit(1);
  }

  // Signup triggers run asynchronously in places; give them a moment.
  await new Promise((r) => setTimeout(r, 2000));

  // ── 2. what did simply existing grant it? ──────────────────────────────
  console.log("signup, before anything was called:");
  {
    const { data: grants } = await admin
      .from("user_module_access")
      .select("module, action")
      .eq("user_id", testUserId);
    const modules = [...new Set((grants ?? []).map((g: { module: string }) => g.module))];
    record(
      "signup grants settings only",
      modules.length === 1 && modules[0] === "settings",
      `got [${modules.join(", ")}]`,
    );
  }

  // ── 3. sign in and call every target as this user ──────────────────────
  console.log("");
  console.log("called as the new user (own JWT):");
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !session?.session) {
    console.error(`could not sign in as the test account: ${signInErr?.message}`);
    Deno.exit(1);
  }
  const jwt = session.session.access_token;

  for (const t of TARGETS) {
    const r = await callAs(t.fn, t.body, { Authorization: `Bearer ${jwt}` });
    const refused = r.status === 409 || /AMAZON_NOT_CONNECTED/.test(r.text);
    record(`${t.fn} refuses an unconnected user`, refused, `status ${r.status}`);
  }

  // ── 4. the scheduled-job path, naming this user ────────────────────────
  //
  // The sharper case. A cron is trusted, so the only thing standing between
  // it and the operator's credentials is whether the USER it names is the
  // operator. Skipped, loudly, when the secret is not supplied.
  console.log("");
  if (INTERNAL_SECRET) {
    console.log("called as a scheduled job naming the new user:");
    for (const t of TARGETS) {
      const r = await callAs(
        t.fn,
        { ...t.body, user_id: testUserId },
        { "x-internal-secret": INTERNAL_SECRET },
      );
      const refused = r.status === 409 || r.status === 400 ||
        /AMAZON_NOT_CONNECTED|not connected/i.test(r.text);
      record(`${t.fn} refuses a job acting for an unconnected user`, refused, `status ${r.status}`);
    }
  } else {
    console.log("scheduled-job path SKIPPED (INTERNAL_SYNC_SECRET not supplied).");
    console.log("This is the path that produced the original copy. Supply the");
    console.log("secret to cover it.");
  }

  // ── 5. THE ASSERTION THAT MATTERS ──────────────────────────────────────
  console.log("");
  console.log("after everything above, does the operator's data appear anywhere?");

  let leaked = 0;

  for (const k of KEYED) {
    const { data: mine, error } = await admin
      .from(k.table)
      .select(k.keys.join(","))
      .eq("user_id", testUserId)
      .limit(500);
    if (error) {
      record(`${k.table}: readable`, false, error.message);
      continue;
    }
    // Cast through `unknown`: the column list is built at runtime, so
    // supabase-js cannot type the result and infers its parse-error shape.
    const rows = (mine ?? []) as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      record(`${k.table}: no rows under the new account`, true);
      continue;
    }

    // Rows exist. Do any of them match the operator's on the natural key?
    let matches = 0;
    for (const row of rows.slice(0, 200)) {
      let q = admin.from(k.table).select("user_id", { count: "exact", head: true })
        .eq("user_id", OWNER_ID);
      for (const key of k.keys) {
        q = row[key] === null || row[key] === undefined
          ? q.is(key, null)
          : q.eq(key, row[key] as string);
      }
      const { count } = await q;
      if ((count ?? 0) > 0) matches++;
    }
    leaked += matches;
    record(
      `${k.table}: none of its rows are the operator's`,
      matches === 0,
      `${rows.length} row(s), ${matches} matching the operator`,
    );
  }

  // ── 6. anything unexpected anywhere else ───────────────────────────────
  const allTables = await tablesWithUserId();
  const unexpected: string[] = [];
  const EXPECTED_DEFAULTS = new Set([
    "user_module_access", "user_subscriptions", "module_usage", "error_reports",
    "source_retailers", "source_excluded_domains", "source_excluded_terms",
    "profiles", "user_settings", "user_preferences",
  ]);
  for (const table of allTables) {
    if (EXPECTED_DEFAULTS.has(table)) continue;
    const { count, error } = await admin
      .from(table)
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", testUserId);
    if (error) continue;
    if ((count ?? 0) > 0) unexpected.push(`${table}=${count}`);
  }
  record(
    "no rows in any table beyond the known per-account defaults",
    unexpected.length === 0,
    unexpected.length ? unexpected.join(" ") : "",
  );

  console.log("");
  console.log(
    leaked === 0
      ? "No row under the new account matched the operator's data."
      : `*** ${leaked} row(s) under the new account match the operator's data. ***`,
  );
} finally {
  // ── 7. clean up ────────────────────────────────────────────────────────
  if (testUserId && !KEEP) {
    const { error } = await admin.auth.admin.deleteUser(testUserId);
    console.log(
      error
        ? `\ncould not delete the test account ${testUserId}: ${error.message}`
        : `\ndeleted the test account ${testUserId}`,
    );
  } else if (testUserId) {
    console.log(`\nkept the test account ${testUserId} (--keep)`);
  }
}

// ── verdict ──────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.ok);
console.log("");
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log("");
  for (const f of failed) console.log(`FAILED: ${f.name}${f.detail ? `  (${f.detail})` : ""}`);
  Deno.exit(1);
}
