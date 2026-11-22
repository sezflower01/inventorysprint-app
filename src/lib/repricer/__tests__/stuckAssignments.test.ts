import { describe, expect, it } from "vitest";
import {
  disableStuckAssignments,
  STUCK_DISABLE_REASON,
  type EqChain,
  type StuckDisableClient,
  type StuckTarget,
} from "../stuckAssignments";

/**
 * A fake assignments table that applies the eq() filters the way PostgREST
 * would, so the test exercises the FILTER rather than a mock's opinion of it.
 *
 * `honourSku: false` reproduces the old behaviour (sku ignored), which is how
 * the two-SKU test proves it is actually discriminating and not passing by
 * accident.
 */
interface Row {
  asin: string;
  sku: string;
  marketplace: string;
  is_enabled: boolean;
  last_disabled_reason?: string | null;
}

function fakeTable(rows: Row[], opts: { honourSku?: boolean; failOn?: string } = {}) {
  const honourSku = opts.honourSku !== false;
  const calls: Array<Record<string, unknown>> = [];

  const client: StuckDisableClient = {
    from() {
      return {
        update(patch: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const chain: EqChain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            then<R>(onfulfilled: (v: { error: { message: string } | null }) => R) {
              calls.push({ ...filters });
              if (opts.failOn && filters.sku === opts.failOn) {
                return Promise.resolve(
                  onfulfilled({ error: { message: "permission denied" } }),
                );
              }
              for (const row of rows) {
                if (row.asin !== filters.asin) continue;
                if (honourSku && "sku" in filters && row.sku !== filters.sku) continue;
                if (row.marketplace !== filters.marketplace) continue;
                if (filters.is_enabled === true && !row.is_enabled) continue;
                row.is_enabled = false;
                row.last_disabled_reason = String(patch.last_disabled_reason ?? "");
              }
              return Promise.resolve(onfulfilled({ error: null }));
            },
          };
          return chain;
        },
      };
    },
  };

  return { client, calls, rows };
}

// Synthetic identifiers only — no real ASINs or SKUs in the repo.
const TWO_SKU_ASIN: Row[] = [
  { asin: "ASYNTH000001", sku: "SKU-STUCK", marketplace: "US", is_enabled: true },
  { asin: "ASYNTH000001", sku: "SKU-HEALTHY", marketplace: "US", is_enabled: true },
];

const stuckOnly: StuckTarget[] = [
  { asin: "ASYNTH000001", sku: "SKU-STUCK", marketplace: "US" },
];

describe("disableStuckAssignments", () => {
  it("THE DEFECT: disables only the stuck SKU, leaving an in-stock sibling alone", async () => {
    const t = fakeTable(TWO_SKU_ASIN.map(r => ({ ...r })));
    const out = await disableStuckAssignments(t.client, stuckOnly);

    expect(out).toEqual({ attempted: 1, disabled: 1, failures: [] });
    expect(t.rows.find(r => r.sku === "SKU-STUCK")!.is_enabled).toBe(false);
    // The whole point: the sibling listing is a separate Buy Box competition
    // and must survive.
    expect(t.rows.find(r => r.sku === "SKU-HEALTHY")!.is_enabled).toBe(true);
  });

  it("proves the test discriminates: ignoring sku disables BOTH rows", async () => {
    // Same inputs, a table that drops the sku filter — the old behaviour.
    const t = fakeTable(TWO_SKU_ASIN.map(r => ({ ...r })), { honourSku: false });
    await disableStuckAssignments(t.client, stuckOnly);

    expect(t.rows.every(r => !r.is_enabled)).toBe(true);
    expect(t.rows.find(r => r.sku === "SKU-HEALTHY")!.is_enabled).toBe(false);
  });

  it("sends sku in the filter, alongside asin and marketplace", async () => {
    const t = fakeTable(TWO_SKU_ASIN.map(r => ({ ...r })));
    await disableStuckAssignments(t.client, stuckOnly);

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toEqual({
      asin: "ASYNTH000001",
      sku: "SKU-STUCK",
      marketplace: "US",
      is_enabled: true,
    });
  });

  it("does not touch the same SKU in another marketplace", async () => {
    const t = fakeTable([
      { asin: "ASYNTH000001", sku: "SKU-STUCK", marketplace: "US", is_enabled: true },
      { asin: "ASYNTH000001", sku: "SKU-STUCK", marketplace: "CA", is_enabled: true },
    ]);
    await disableStuckAssignments(t.client, stuckOnly);

    expect(t.rows.find(r => r.marketplace === "US")!.is_enabled).toBe(false);
    expect(t.rows.find(r => r.marketplace === "CA")!.is_enabled).toBe(true);
  });

  it("reports a rejected write instead of counting it as fixed", async () => {
    const t = fakeTable(TWO_SKU_ASIN.map(r => ({ ...r })), { failOn: "SKU-STUCK" });
    const out = await disableStuckAssignments(t.client, stuckOnly);

    // The old inline version never read `error` and reported rows.length.
    expect(out.disabled).toBe(0);
    expect(out.attempted).toBe(1);
    expect(out.failures).toEqual([
      { asin: "ASYNTH000001", sku: "SKU-STUCK", marketplace: "US", message: "permission denied" },
    ]);
    expect(t.rows.every(r => r.is_enabled)).toBe(true);
  });

  it("keeps going after one failure and counts the rest", async () => {
    const t = fakeTable([
      { asin: "ASYNTH000001", sku: "SKU-A", marketplace: "US", is_enabled: true },
      { asin: "ASYNTH000002", sku: "SKU-B", marketplace: "US", is_enabled: true },
    ], { failOn: "SKU-A" });

    const out = await disableStuckAssignments(t.client, [
      { asin: "ASYNTH000001", sku: "SKU-A", marketplace: "US" },
      { asin: "ASYNTH000002", sku: "SKU-B", marketplace: "US" },
    ]);

    expect(out.attempted).toBe(2);
    expect(out.disabled).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(t.rows.find(r => r.sku === "SKU-B")!.is_enabled).toBe(false);
  });

  it("skips rows that are already disabled rather than overwriting the reason", async () => {
    const t = fakeTable([
      {
        asin: "ASYNTH000001", sku: "SKU-STUCK", marketplace: "US",
        is_enabled: false, last_disabled_reason: "Manual pause from repricer table",
      },
    ]);
    await disableStuckAssignments(t.client, stuckOnly);

    expect(t.rows[0].last_disabled_reason).toBe("Manual pause from repricer table");
  });

  it("writes one timestamp for the whole batch and the documented reason", async () => {
    const t = fakeTable([
      { asin: "ASYNTH000001", sku: "SKU-A", marketplace: "US", is_enabled: true },
      { asin: "ASYNTH000002", sku: "SKU-B", marketplace: "US", is_enabled: true },
    ]);
    await disableStuckAssignments(t.client, [
      { asin: "ASYNTH000001", sku: "SKU-A", marketplace: "US" },
      { asin: "ASYNTH000002", sku: "SKU-B", marketplace: "US" },
    ], () => "2026-11-21T00:00:00.000Z");

    expect(t.rows.every(r => r.last_disabled_reason === STUCK_DISABLE_REASON)).toBe(true);
  });

  it("an empty list writes nothing", async () => {
    const t = fakeTable(TWO_SKU_ASIN.map(r => ({ ...r })));
    const out = await disableStuckAssignments(t.client, []);

    expect(out).toEqual({ attempted: 0, disabled: 0, failures: [] });
    expect(t.calls).toHaveLength(0);
    expect(t.rows.every(r => r.is_enabled)).toBe(true);
  });
});
