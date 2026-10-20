// Regression test for the silent-success defect.
//
// B00LFXMBKI reported available=0 from 2026-09-03 to 2026-10-20 while Amazon
// held 145 units and the ASIN sold 52. rescue-inventory-asin was declining to
// write every single time (the row is tombstoned NOT_IN_CATALOG) and SAYING SO
// in `skipped_update_reason` -- but inventory-refresh-worker only looked at
// res.ok, so all ~370 three-hourly queue rows recorded 'success'.
//
// The first case below is that exact payload. If it ever classifies as
// "written" again, the queue is lying about stock again.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readRescueOutcome } from "../../inventory-refresh-worker/rescue-outcome.ts";

const body = (o: Record<string, unknown>) => JSON.stringify(o);

Deno.test("THE BUG: a tombstoned decline is not a success", () => {
  const out = readRescueOutcome(200, body({
    asin: "B00LFXMBKI",
    sku: "6DA-X5B-Y5SO",
    skipped_update_reason: "tombstoned:NOT_IN_CATALOG",
    updated_db: null,
    had_existing_record: true,
  }));
  assertEquals(out, { kind: "declined", reason: "tombstoned:NOT_IN_CATALOG" });
});

Deno.test("every other real decline reason rescue can emit", () => {
  for (const reason of [
    "tombstoned:DELETED",
    "no_exact_seller_sku_match",
    "no_summary_any_marketplace",
    "non_us_marketplace_skipped:CA",
    "non_us_marketplace_skipped:MX",
    "non_us_marketplace_skipped:BR",
    "suspicious_zero_unconfirmed",
  ]) {
    assertEquals(
      readRescueOutcome(200, body({ skipped_update_reason: reason })),
      { kind: "declined", reason },
      `expected a decline for ${reason}`,
    );
  }
});

Deno.test("a real write is still a success", () => {
  const out = readRescueOutcome(200, body({
    asin: "B002HJ4HSS",
    skipped_update_reason: null,
    updated_db: { available: 145, reserved: 2, inbound: 0, listing_status: "ACTIVE" },
  }));
  assertEquals(out, { kind: "written" });
});

Deno.test("a DB write failure is RETRYABLE, not a terminal skip", () => {
  // rescue reports these in the same field, inside a 200. Classifying them as
  // declines would convert a transient Postgres error into a permanent skip.
  const upd = readRescueOutcome(200, body({
    skipped_update_reason: 'update_failed:deadlock detected',
  }));
  assertEquals(upd.kind, "failed");
  const ins = readRescueOutcome(200, body({
    skipped_update_reason: 'insert_failed:duplicate key value violates unique constraint',
  }));
  assertEquals(ins.kind, "failed");
});

Deno.test("non-2xx keeps the body snippet for last_error", () => {
  const out = readRescueOutcome(500, "upstream exploded");
  assertEquals(out, { kind: "failed", error: "rescue 500: upstream exploded" });
  // and it must not run away with a huge body
  const long = readRescueOutcome(502, "x".repeat(5000));
  assertEquals(long.kind, "failed");
  assertEquals((long as { error: string }).error.length, "rescue 502: ".length + 300);
});

Deno.test("degrade to the OLD behaviour, never to a flood of skips", () => {
  // If the response shape changes, a wrong "written" is recoverable; a wrong
  // "declined" on every row would stall the queue's apparent progress.
  assertEquals(readRescueOutcome(200, "OK").kind, "written");
  assertEquals(readRescueOutcome(200, "").kind, "written");
  assertEquals(readRescueOutcome(200, "null").kind, "written");
  assertEquals(readRescueOutcome(200, body({})).kind, "written");
  assertEquals(readRescueOutcome(200, body({ skipped_update_reason: "" })).kind, "written");
  assertEquals(readRescueOutcome(200, body({ skipped_update_reason: "   " })).kind, "written");
  assertEquals(readRescueOutcome(200, body({ skipped_update_reason: 42 })).kind, "written");
});

Deno.test("204 counts as 2xx", () => {
  assertEquals(readRescueOutcome(204, "").kind, "written");
});
