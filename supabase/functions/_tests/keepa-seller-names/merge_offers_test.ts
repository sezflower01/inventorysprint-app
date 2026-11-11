// Showing more than Amazon's 20 offers, without lying about which are live.
//
// SP-API getItemOffers caps at 20 with no pagination; Summary.TotalOfferCount
// reports the truth, which is why the panel said "20 live of 71 (Amazon API
// limit)". The other 51 were never missing -- the Keepa /product response
// already carries the full list and the code discarded it whenever SP-API
// answered. offers=20 and offers=100 return an identical list (measured
// 2026-08-17), so that data is already paid for at the 5 tokens the price
// history costs.
//
// The risk in merging is not cost, it is CORRECTNESS: a Keepa offer must
// never outrank the live one for the same seller, and must never claim the
// Buy Box, or every downstream "who owns the Buy Box" calculation breaks.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mergeOfferSources } from "../../mobile-scan-price-history/index.ts";

const sp = (sellerId: string, landed: number, extra: Record<string, unknown> = {}) => ({
  sellerId, landed, isFBA: true, sellerName: "Live " + sellerId, ...extra,
});
const kp = (sellerId: string, landed: number, extra: Record<string, unknown> = {}) => ({
  sellerId, landed, isFBA: false, sellerName: "Keepa " + sellerId, ...extra,
});

Deno.test("Keepa-only sellers are added past Amazon's cap", () => {
  const merged = mergeOfferSources([sp("A", 20)], [kp("B", 21), kp("C", 22)]);
  assertEquals(merged.length, 3, "all three competitors must survive");
  assertEquals(merged.map((o) => o.sellerId), ["A", "B", "C"]);
});

Deno.test("SP-API wins for a seller both sources know", () => {
  const merged = mergeOfferSources([sp("A", 20)], [kp("A", 99)]);
  assertEquals(merged.length, 1, "no duplicate rows for one seller");
  assertEquals(merged[0].sellerName, "Live A", "the live record must win");
  assertEquals(merged[0].landed, 20, "and carry the live price, not Keepa's");
});

Deno.test("seller id match is case-insensitive", () => {
  const merged = mergeOfferSources([sp("ABC123", 20)], [kp("abc123", 99)]);
  assertEquals(merged.length, 1, "casing must not create a phantom competitor");
});

Deno.test("a Keepa offer can NEVER claim the Buy Box", () => {
  // Keepa's isBuyBox reflects its own last sighting and would collide with
  // SP-API's IsBuyBoxWinner, producing two winners.
  const merged = mergeOfferSources([sp("A", 20, { isBuyBox: true })], [kp("B", 19, { isBuyBox: true })]);
  const winners = merged.filter((o) => o.isBuyBox);
  assertEquals(winners.length, 1, "exactly one Buy Box winner");
  assertEquals(winners[0].sellerId, "A", "and it is the one SP-API named");
});

Deno.test("liveVerified separates confirmed-now from last-seen", () => {
  const merged = mergeOfferSources([sp("A", 20)], [kp("B", 21)]);
  assertEquals(merged.find((o) => o.sellerId === "A")?.liveVerified, true);
  assertEquals(merged.find((o) => o.sellerId === "B")?.liveVerified, false);
});

Deno.test("result is sorted by landed price across both sources", () => {
  const merged = mergeOfferSources([sp("A", 25), sp("B", 20)], [kp("C", 22), kp("D", 18)]);
  assertEquals(merged.map((o) => o.landed), [18, 20, 22, 25]);
});

Deno.test("offers with no usable price are dropped, not rendered as blanks", () => {
  const merged = mergeOfferSources([sp("A", 20)], [
    kp("B", NaN as unknown as number),
    { sellerId: "C", sellerName: "no landed" },
    kp("", 15),
  ]);
  assertEquals(merged.map((o) => o.sellerId), ["A"]);
});

Deno.test("empty or missing sources degrade quietly", () => {
  assertEquals(mergeOfferSources([], []).length, 0);
  assertEquals(mergeOfferSources([sp("A", 20)], []).length, 1);
  assertEquals(mergeOfferSources([], [kp("B", 21)]).length, 1);
  assertEquals(
    mergeOfferSources(null as unknown as any[], undefined as unknown as any[]).length,
    0,
    "must not throw when a source is absent",
  );
});

Deno.test("the reported case: 20 live + 51 from Keepa = 71", () => {
  const live = Array.from({ length: 20 }, (_, i) => sp("LIVE" + i, 20 + i));
  const keepa = Array.from({ length: 51 }, (_, i) => kp("KEEPA" + i, 50 + i));
  const merged = mergeOfferSources(live, keepa);
  assertEquals(merged.length, 71, "no competitor left behind Amazon's cap");
  assertEquals(merged.filter((o) => o.liveVerified).length, 20);
  assertEquals(merged.filter((o) => !o.liveVerified).length, 51);
  assert(merged.slice(0, 20).every((o) => o.liveVerified), "cheapest 20 here are the live ones");
});
