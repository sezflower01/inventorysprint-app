// A seller Keepa has no record of must stop being asked about.
//
// The bug, measured live 2026-11-11: 5,626 of 38,225 cached sellers were
// re-queried from Keepa on EVERY scan and never resolved -- 4,394 of them
// first asked about more than a month earlier, the oldest in May.
//
// resolveSellerNamesCached decided freshness with
//   `current_rating != null OR current_rating_count != null`
// which exists so rows predating the rating columns get one backfill. A Keepa
// MISS also has both rating columns NULL, so the two were indistinguishable
// and the miss was never fresh.
//
// These tests pin the distinction: a row WITH a name and no rating is still
// force-refetched once (the backfill must keep working), while a row with NO
// name backs off on miss_count. Breaking either one re-opens the loop.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { missBackoffMs, resolveSellerNamesCached } from "../../mobile-scan-price-history/index.ts";

const DAY = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

/** Minimal stand-in for the one query resolveSellerNamesCached makes. */
function makeAdmin(rows: Row[]) {
  let captured: string[] = [];
  const api = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, ids: string[]) {
              captured = ids;
              return {
                eq(_c: string, _v: string) {
                  return Promise.resolve({
                    data: rows.filter((r) => ids.includes(String(r.seller_id))),
                  });
                },
              };
            },
          };
        },
      };
    },
    get requestedIds() {
      return captured;
    },
  };
  return api;
}

function missRow(sellerId: string, missCount: number, lastAttemptAgoMs: number): Row {
  return {
    seller_id: sellerId,
    business_name: null,
    storefront_name: null,
    is_amazon: false,
    current_rating: null,
    current_rating_count: null,
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    miss_count: missCount,
    last_attempt_at: new Date(Date.now() - lastAttemptAgoMs).toISOString(),
  };
}

Deno.test("backoff escalates 1 -> 3 -> 7 -> 30 days and caps", () => {
  assertEquals(missBackoffMs(0), 1 * DAY);
  assertEquals(missBackoffMs(1), 1 * DAY);
  assertEquals(missBackoffMs(2), 3 * DAY);
  assertEquals(missBackoffMs(3), 7 * DAY);
  assertEquals(missBackoffMs(4), 30 * DAY);
  assertEquals(missBackoffMs(99), 30 * DAY, "must cap, not grow without bound");
});

Deno.test("a recent miss is NOT re-queried -- this is the whole fix", async () => {
  const admin = makeAdmin([missRow("A_MISS", 1, 2 * 60 * 60 * 1000)]); // 2h ago
  const { names, missing } = await resolveSellerNamesCached(admin, "US", ["A_MISS"]);
  assertEquals(missing, [], "a miss inside its backoff window must not be re-asked");
  assertEquals(names["A_MISS"].name, "A_MISS", "UI still falls back to the raw ID");
});

Deno.test("a miss past its backoff window IS re-queried", async () => {
  const admin = makeAdmin([missRow("A_OLD", 1, 2 * DAY)]); // 1-day backoff, 2 days ago
  const { missing } = await resolveSellerNamesCached(admin, "US", ["A_OLD"]);
  assertEquals(missing, ["A_OLD"], "a genuinely due miss must still be retried");
});

Deno.test("an escalated miss stays quiet far longer", async () => {
  // 4 misses -> 30-day window. Ten days on, it is still not due.
  const admin = makeAdmin([missRow("A_DEAD", 4, 10 * DAY)]);
  const { missing } = await resolveSellerNamesCached(admin, "US", ["A_DEAD"]);
  assertEquals(missing, [], "30-day backoff must hold at 10 days");
});

Deno.test("REGRESSION: the May row that was re-queried every scan", async () => {
  // Exactly the shape found in production: nameless, no ratings, months old.
  // Under the old freshness test this landed in `missing` on every call.
  const admin = makeAdmin([missRow("ACFTZT4RZLOYH", 4, 190 * DAY)]);
  const { missing } = await resolveSellerNamesCached(admin, "US", ["ACFTZT4RZLOYH"]);
  // Past 30 days it IS due again -- once a month, not once a scan.
  assertEquals(missing, ["ACFTZT4RZLOYH"]);

  const fresh = makeAdmin([missRow("ACFTZT4RZLOYH", 4, 1 * DAY)]);
  const second = await resolveSellerNamesCached(fresh, "US", ["ACFTZT4RZLOYH"]);
  assertEquals(second.missing, [], "and silent for the other 29 days");
});

Deno.test("the rating backfill still fires for a NAMED row with no rating", async () => {
  // Written before the rating columns existed. Must be refetched once.
  const admin = makeAdmin([{
    seller_id: "A_NAMED",
    business_name: "Real Store",
    storefront_name: "Real Store",
    is_amazon: false,
    current_rating: null,
    current_rating_count: null,
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    miss_count: 0,
    last_attempt_at: new Date(Date.now() - 1000).toISOString(),
  }]);
  const { names, missing } = await resolveSellerNamesCached(admin, "US", ["A_NAMED"]);
  assertEquals(missing, ["A_NAMED"], "named-but-ratingless must still backfill");
  assertEquals(names["A_NAMED"].name, "Real Store", "and show the name meanwhile");
});

Deno.test("a complete, unexpired row is left alone", async () => {
  const admin = makeAdmin([{
    seller_id: "A_GOOD",
    business_name: "Mardel Christian Store",
    storefront_name: "Mardel Christian Store",
    is_amazon: false,
    current_rating: 88,
    current_rating_count: 1200,
    expires_at: new Date(Date.now() + 3 * DAY).toISOString(),
    miss_count: 0,
    last_attempt_at: new Date(Date.now() - 1000).toISOString(),
  }]);
  const { names, missing } = await resolveSellerNamesCached(admin, "US", ["A_GOOD"]);
  assertEquals(missing, []);
  assertEquals(names["A_GOOD"].name, "Mardel Christian Store");
  assertEquals(names["A_GOOD"].rating, 88);
});

Deno.test("an uncached seller is asked about", async () => {
  const admin = makeAdmin([]);
  const { names, missing } = await resolveSellerNamesCached(admin, "US", ["A3HRO6X2J3TLPL"]);
  assertEquals(missing, ["A3HRO6X2J3TLPL"], "never-seen sellers must be looked up");
  assert(!names["A3HRO6X2J3TLPL"], "and carry no name until Keepa answers");
});

Deno.test("Amazon's own IDs never reach Keepa", async () => {
  const admin = makeAdmin([]);
  const { names, missing } = await resolveSellerNamesCached(admin, "US", ["ATVPDKIKX0DER"]);
  assertEquals(missing, [], "Amazon retail is known locally -- no API call");
  assertEquals(names["ATVPDKIKX0DER"].name, "Amazon.com");
  assertEquals(names["ATVPDKIKX0DER"].isAmazon, true);
});
