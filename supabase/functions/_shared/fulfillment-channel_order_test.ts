// Tests for the ORDER-channel helpers.
//
// These exist because the write path and the read path must disagree, and that
// is easy to "tidy" into a bug. Writing must never invent a channel; reading
// must keep treating unknown as FBA so that no existing fee or ROI figure
// moves. A test that only checked one direction would let either half drift.
//
// Real values from the live data, measured 2026-10-19:
//   57,509 rows  fulfillment_channel NULL
//   14,087 rows  AFN  (some of which are the old `|| 'AFN'` guess, not a fact)
//      124 rows  MFN
// and 45 of 88 originally-known MFN orders also carried an fba_fee, which is
// why fba_fee is NOT used anywhere in this logic.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  storedOrderChannel,
  orderIsFbm,
  orderChannelIsKnown,
  orderChannelKey,
} from "./fulfillment-channel.ts";

Deno.test("storedOrderChannel records Amazon's answer and nothing else", () => {
  assertEquals(storedOrderChannel("AFN"), "AFN");
  assertEquals(storedOrderChannel("MFN"), "MFN");
  assertEquals(storedOrderChannel("afn"), "AFN");
  assertEquals(storedOrderChannel(" mfn "), "MFN");
});

Deno.test("storedOrderChannel NEVER defaults to AFN", () => {
  // The whole defect in one test. `|| 'AFN'` is what produced 14,068
  // unverifiable AFN rows.
  for (const silent of [undefined, null, "", "   ", "UNKNOWN", "unknown"]) {
    assertEquals(storedOrderChannel(silent), null, `expected null for ${JSON.stringify(silent)}`);
  }
});

Deno.test("an unexpected value is NULL, not coerced", () => {
  // Amazon adding a third channel must not silently become FBA.
  assertEquals(storedOrderChannel("AMAZON_NA"), null);
  assertEquals(storedOrderChannel("DEFAULT"), null);
  assertEquals(storedOrderChannel("FBA"), null);
  assertEquals(storedOrderChannel("FBM"), null);
});

Deno.test("READ path: only a stated MFN is FBM", () => {
  assertEquals(orderIsFbm("MFN"), true);
  assertEquals(orderIsFbm("AFN"), false);
});

Deno.test("READ path: unknown behaves as FBA, so existing figures do not shift", () => {
  // This is the compatibility guarantee. Every pre-existing caller did
  // `=== 'MFN'`, so NULL was already not-FBM. If this ever returns true for an
  // unknown channel, fee quotes and repricer assignments on 57,509 rows move.
  for (const unknown of [undefined, null, "", "UNKNOWN"]) {
    assertEquals(orderIsFbm(unknown), false, `unknown must not read as FBM: ${JSON.stringify(unknown)}`);
    assertEquals(orderChannelKey(unknown), "FBA", "unknown must group as FBA");
  }
});

Deno.test("orderChannelIsKnown separates 'Amazon said FBA' from 'nobody knows'", () => {
  // The distinction the FBM label screen needs: an AFN order should not be
  // offered a label fee, but an UNKNOWN order might genuinely be FBM.
  assertEquals(orderChannelIsKnown("AFN"), true);
  assertEquals(orderChannelIsKnown("MFN"), true);
  assertEquals(orderChannelIsKnown(null), false);
  assertEquals(orderChannelIsKnown(""), false);
});

Deno.test("write and read agree on the two stated values", () => {
  // Round-trip: whatever is stored must read back the same way.
  assertEquals(orderChannelKey(storedOrderChannel("MFN")), "FBM");
  assertEquals(orderChannelKey(storedOrderChannel("AFN")), "FBA");
  // And a silence stored as NULL still reads as FBA, not as FBM.
  assertEquals(orderChannelKey(storedOrderChannel(undefined)), "FBA");
});

Deno.test("fba_fee is deliberately irrelevant to this logic", () => {
  // 51.1 pct of known-MFN orders carry an fba_fee, so it cannot discriminate.
  // These helpers take only the channel, which is what keeps that mistake out.
  assertEquals(orderIsFbm("MFN"), true); // regardless of any fee on the row
  assertEquals(orderIsFbm(null), false); // regardless of any fee on the row
});
