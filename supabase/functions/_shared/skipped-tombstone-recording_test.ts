/**
 * A skipped inventory refresh must be RECORDED as skipped, never as success.
 *
 * ── THE BUG THIS GUARDS ───────────────────────────────────────────────
 *
 * rescue-inventory-asin declines to write when the target row is tombstoned
 * (listing_status NOT_IN_CATALOG / DELETED) -- correctly, because
 * fn_protect_ghost_tombstone would revert the status anyway and only a
 * deliberate force_relist write may reopen it. But it returns HTTP 200 either
 * way, and inventory-refresh-worker used to ignore the body entirely. So the
 * 3-hourly refresh queue reported SUCCESS on every run for rows where nothing
 * had been written.
 *
 * Lived consequence (B00LFXMBKI, 2026-09-03 to 2026-10-20): 29,575 queue rows
 * recorded success while the row sat at available 0 with Amazon holding 145
 * fulfillable units. The ASIN sold 52 units in that window and was absent from
 * Inventory Valuation, the repricer and the shipment builder the whole time.
 * Nobody read the reason because the queue said everything was fine.
 *
 * ── WHY THIS IS A SOURCE TEST ─────────────────────────────────────────
 *
 * The behaviour lives in a long request handler that needs SP-API
 * credentials, a seller authorization and a live Supabase client to reach --
 * there is no seam to call it through. What CAN be asserted cheaply, and is
 * what actually broke, is the contract between the two files:
 *
 *   1. rescue-inventory-asin must SET a skip reason on the tombstone branch
 *      and must RETURN both that reason and a boolean saying whether it wrote;
 *   2. inventory-refresh-worker must READ that reason and mark the queue row
 *      skipped rather than succeeded.
 *
 * Either half alone restores the silent success, which is why both are
 * asserted here rather than in two separate tests. Same reasoning as
 * order-items-writers_test.ts: the defect was never a wrong function, it was a
 * value that nothing downstream looked at.
 */

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function src(fn: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url));
}

Deno.test("rescue-inventory-asin sets a skip reason for a tombstoned row", async () => {
  const s = await src("rescue-inventory-asin");

  assert(
    /isGhostTombstone\s*=\s*[^;]*NOT_IN_CATALOG[^;]*DELETED/s.test(s),
    "rescue-inventory-asin must still detect a tombstoned row from " +
    "listing_status NOT_IN_CATALOG / DELETED.",
  );

  assert(
    /skippedUpdateReason\s*=\s*`tombstoned:/.test(s),
    "the tombstone branch must set skippedUpdateReason = `tombstoned:<status>`. " +
    "Without a reason the worker cannot tell a decline from a write, and the " +
    "queue goes back to reporting success for rows it never touched.",
  );

  // The guard must come BEFORE the write branch, or the write happens anyway.
  const guardAt = s.indexOf("skippedUpdateReason = `tombstoned:");
  const writeAt = s.indexOf("attemptedWritePayload = {");
  assert(guardAt > -1 && writeAt > -1 && guardAt < writeAt,
    "the tombstone check must be evaluated before the write payload is built; " +
    "a guard after the write is not a guard.",
  );
});

Deno.test("rescue-inventory-asin reports the reason and whether it wrote", async () => {
  const s = await src("rescue-inventory-asin");
  for (const field of ["skipped_update_reason", "db_write_succeeded"]) {
    assert(
      new RegExp(`${field}\\s*:`).test(s),
      `the response must include ${field}. A 200 with no such field is ` +
      `indistinguishable from a successful write, which is the original bug.`,
    );
  }
});

Deno.test("inventory-refresh-worker marks skipped rows skipped, not successful", async () => {
  const s = await src("inventory-refresh-worker");

  assert(
    /mark_inventory_refresh_skipped/.test(s),
    "the worker must call mark_inventory_refresh_skipped for a declined item. " +
    "Counting it as success is what hid B00LFXMBKI for seven weeks.",
  );

  assert(
    /skipped(Reasons|\+\+)/.test(s),
    "the worker must track skips separately from successes so a run that " +
    "wrote nothing cannot report as a clean run.",
  );

  // The fallback on a failed mark must not silently become a success without
  // saying so -- it logs. Assert the log exists, so a future edit that drops
  // it is visible.
  assert(
    /falling back to success/.test(s),
    "if mark_inventory_refresh_skipped itself fails the worker falls back to " +
    "success; that fallback must stay logged, or the silent success returns " +
    "through the error path instead of the happy path.",
  );
});
