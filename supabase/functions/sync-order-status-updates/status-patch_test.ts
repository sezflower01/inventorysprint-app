import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { isCancelledStatus, needsWrite, statusPatch } from "./status-patch.ts";

const NOW = "2026-10-07T18:00:00.000Z";

// ── direction 1: Amazon cancels an order ────────────────────────────────────
Deno.test("Canceled sets the flag and stamps cancelled_at", () => {
  const p = statusPatch("Canceled", NOW);
  assertEquals(p.order_status, "Canceled");
  assertEquals(p.is_cancelled, true);
  assertEquals(p.cancelled_at, NOW);
});

Deno.test("Amazon's British spelling is handled too", () => {
  // Amazon returns 'Canceled' on the US marketplace, but the column already
  // holds both spellings from older sync paths, so both must map the same way.
  assertEquals(isCancelledStatus("Cancelled"), true);
  assertEquals(statusPatch("Cancelled", NOW).is_cancelled, true);
});

// ── direction 2: the order comes back ───────────────────────────────────────
Deno.test("moving away from Canceled clears the flag AND cancelled_at", () => {
  const p = statusPatch("Shipped", NOW);
  assertEquals(p.is_cancelled, false);
  // A stale cancelled_at on a reinstated order reads as cancelled to anything
  // that checks the timestamp rather than the flag.
  assertEquals(p.cancelled_at, null);
});

Deno.test("Pending and Unshipped are not cancelled", () => {
  for (const s of ["Pending", "Unshipped", "PartiallyShipped", "InvoiceUnconfirmed"]) {
    assertEquals(statusPatch(s, NOW).is_cancelled, false, `${s} should not be cancelled`);
  }
});

// ── observability: both columns were previously never written ───────────────
Deno.test("every patch records when and who looked", () => {
  const p = statusPatch("Shipped", NOW);
  assertEquals(p.last_status_sync_at, NOW);
  assertEquals(p.status_source, "amazon_status_sync");
});

// ── the guard that the old query-level .neq() got wrong ─────────────────────
Deno.test("THE REGRESSION: status already Canceled but flag still false must write", () => {
  // This is the exact shape of the 321 rows found on 2026-10-07. The old guard
  // was .neq("order_status", status), so these were skipped forever precisely
  // because the status had NOT changed.
  assertEquals(needsWrite({ order_status: "Canceled", is_cancelled: false }, "Canceled"), true);
});

Deno.test("a row already correct is left alone", () => {
  assertEquals(needsWrite({ order_status: "Canceled", is_cancelled: true }, "Canceled"), false);
  assertEquals(needsWrite({ order_status: "Shipped", is_cancelled: false }, "Shipped"), false);
});

Deno.test("a genuine status change writes", () => {
  assertEquals(needsWrite({ order_status: "Pending", is_cancelled: false }, "Shipped"), true);
  assertEquals(needsWrite({ order_status: "Pending", is_cancelled: false }, "Canceled"), true);
});

Deno.test("un-cancelling writes, in the other direction", () => {
  assertEquals(needsWrite({ order_status: "Canceled", is_cancelled: true }, "Shipped"), true);
});

Deno.test("a row we do not have is not invented", () => {
  // This worker updates only; creating orders is fetch-live-orders' job.
  assertEquals(needsWrite(null, "Shipped"), false);
});

// ── the round trip, end to end ──────────────────────────────────────────────
Deno.test("cancel then reinstate leaves no trace of the cancellation", () => {
  const cancelled = statusPatch("Canceled", NOW);
  assertEquals(cancelled.is_cancelled, true);
  assertEquals(cancelled.cancelled_at, NOW);

  const reinstated = statusPatch("Unshipped", "2026-10-08T09:00:00.000Z");
  assertEquals(reinstated.is_cancelled, false);
  assertEquals(reinstated.cancelled_at, null);
  assertEquals(reinstated.order_status, "Unshipped");
});
