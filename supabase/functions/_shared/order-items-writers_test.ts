/**
 * Every writer that reads GetOrderItems MUST merge repeated ASIN lines.
 *
 * ── WHY THIS TEST EXISTS, AND WHY order-items_test.ts WAS NOT ENOUGH ──
 *
 * mergeOrderItemsByAsin has had eight passing unit tests since d51b6d5
 * (2026-09-09), including "2 lines of one ASIN become 3 units at 23.67" and
 * "single-item and empty orders pass straight through". Those tests were green
 * the entire time the bug was corrupting data, because the helper was never
 * broken -- fetch-live-orders simply never called it.
 *
 * Measured 2026-10-31, seven weeks after the "fix": 283 orders in 2026 with
 * 582 units missing, COGS understated $4,760.79, and the monthly count rising
 * from 11-20 through June to 58 / 58 / 63 in August / September / October.
 * Worse AFTER the fix, because the fix reached one writer out of two.
 *
 * So a unit test on the helper cannot protect this invariant. The invariant is
 * about CALL SITES: wherever Amazon's OrderItems array enters this codebase, it
 * must pass through the merge before anything keyed on (order_id, asin) is
 * built from it. That is what this asserts, by reading the source.
 *
 * A source-reading test is unusual and deliberately narrow. It is the only
 * level at which "the helper is not called" is expressible.
 */

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/** Writers that read GetOrderItems and upsert rows keyed on (order_id, asin). */
const WRITERS = [
  "fetch-live-orders",
  "sync-sales-orders",
];

const HELPER = "mergeOrderItemsByAsin";

/**
 * An opt-out for read sites that take only IDENTITY fields (ASIN, Title) and
 * never quantity or money. Those cannot collapse anything, because both lines
 * of a repeated ASIN carry the same ASIN.
 *
 * It must be written at the read site as a comment, so the exemption is
 * deliberate and reviewable rather than implicit. The first use is
 * sync-sales-orders' fetchOrderItemsForRefund, which exists only to recover an
 * ASIN for a refund whose ASIN is unknown.
 */
const IDENTITY_ONLY = "ORDER_ITEMS_IDENTITY_ONLY";

/** Matches `payload.OrderItems` and `payload?.OrderItems`. */
const PAYLOAD_RE = /payload\??\.OrderItems/g;

async function readWriter(name: string): Promise<string> {
  const url = new URL(`../${name}/index.ts`, import.meta.url);
  return await Deno.readTextFile(url);
}

for (const writer of WRITERS) {
  Deno.test(`${writer} imports ${HELPER}`, async () => {
    const src = await readWriter(writer);
    assert(
      new RegExp(`import\\s*\\{[^}]*\\b${HELPER}\\b[^}]*\\}\\s*from\\s*['"][^'"]*order-items\\.ts['"]`)
        .test(src),
      `${writer}/index.ts must import ${HELPER} from _shared/order-items.ts. ` +
      `Without it, two OrderItems for one ASIN collapse onto a single ` +
      `sales_orders row and the second upsert replaces the first's quantity.`,
    );
  });

  Deno.test(`${writer} merges every OrderItems array it reads`, async () => {
    const src = await readWriter(writer);
    const matches = [...src.matchAll(PAYLOAD_RE)];

    assert(
      matches.length > 0,
      `${writer}/index.ts no longer reads payload.OrderItems. If the API shape ` +
      `changed, update PAYLOAD_RE in this test -- do not delete the writer ` +
      `from WRITERS, which would silently drop the guard.`,
    );

    for (const m of matches) {
      const at = m.index ?? 0;
      // The merge may wrap the expression (`mergeOrderItemsByAsin(payload...)`)
      // or be applied to it on one of the next few lines, as when the raw array
      // is bound first and merged immediately after. Both are correct; a raw
      // array that reaches a consumer unmerged is not.
      const before = src.slice(Math.max(0, at - 800), at);
      const after = src.slice(at, at + 400);
      assert(
        before.includes(HELPER) || after.includes(HELPER)
          || before.includes(IDENTITY_ONLY) || after.includes(IDENTITY_ONLY),
        `${writer}/index.ts reads payload.OrderItems at offset ${at} without ` +
        `${HELPER} nearby. Merge it before anything keyed on ` +
        `(order_id, asin) is built from it, or -- if the site takes only ASIN ` +
        `and Title and never quantity or money -- mark it ${IDENTITY_ONLY} ` +
        `with a comment saying why.\n\n` +
        `Context:\n${src.slice(Math.max(0, at - 160), at + 200)}`,
      );
    }
  });
}

/**
 * The enrichment path in fetch-live-orders takes items[0]. That is correct ONLY
 * because the array is merged, so items[0] holds its ASIN's full quantity.
 * If the merge is ever removed from the build site, items[0] silently reverts
 * to "the first of several lines for one ASIN" -- the collapse, from the
 * reading side -- so the two facts are asserted together.
 */
Deno.test("fetch-live-orders items[0] enrichment is paired with a merged source", async () => {
  const src = await readWriter("fetch-live-orders");
  if (!/const item = items\[0\]/.test(src)) return; // path removed: nothing to guard
  assert(
    /orderItemsMap\.set\([^)]*\)/.test(src) && src.includes(HELPER),
    "fetch-live-orders still takes items[0] in the enrichment path, so the " +
    "orderItemsMap build site must apply " + HELPER + ".",
  );
});
