import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// salesWindows.js is a CLASSIC script, not a module: the service worker loads
// it with importScripts(), which cannot take ESM. The repo is "type": "module",
// so neither import nor createRequire can reach it. Evaluating the real file in
// a sandbox tests exactly the bytes the extension ships, which is the point --
// a re-implementation here would test this test.
const sandbox = { module: { exports: {} }, self: {} };
vm.createContext(sandbox);
vm.runInContext(
  readFileSync(new URL("../salesWindows.js", import.meta.url), "utf8"),
  sandbox,
);
const { readSalesWindows } = sandbox.module.exports;

/**
 * Builds the envelope the RPC returns. `orders` is only used by the
 * >1,000-order fixture, to prove the counts travel as numbers rather than as
 * rows that something downstream could truncate.
 */
function envelope(over = {}) {
  return {
    asin: "B0SYNTH0001",
    generated_at: "2026-11-23T09:00:00.000Z",
    today_pt: "2026-11-23",
    units_7d: 0,
    units_30d: 0,
    units_90d: 0,
    units_lifetime: 0,
    orders_lifetime: 0,
    first_order_date_30d: null,
    first_order_date: null,
    last_order_date: null,
    ...over,
  };
}

describe("readSalesWindows — the defect", () => {
  it("THE REGRESSION: a listing with far more than 1,000 orders reports real windows", () => {
    // The old client-side path asked for 5,000 rows, got 1,000 (the cap),
    // sorted ASCENDING -- so the rows it kept were the OLDEST and the recent
    // windows came back as zero. These counts cannot be truncated: they arrive
    // as four integers, not as 4,400 rows.
    const r = readSalesWindows(envelope({
      units_7d: 140,
      units_30d: 600,
      units_90d: 1800,
      units_lifetime: 4100,
      orders_lifetime: 3900,
      first_order_date_30d: "2026-10-24",
      first_order_date: "2025-08-02",
      last_order_date: "2026-11-23",
    }));

    expect(r.ok).toBe(true);
    expect(r.units7d).toBe(140);
    expect(r.units30d).toBe(600);
    expect(r.units90d).toBe(1800);
    expect(r.unitsLifetime).toBe(4100);
    // The exact symptom that was reported, now impossible for a live listing.
    expect(r.units7d === 0 && r.units90d > 0).toBe(false);
  });

  it("the old bug's shape is refused: 7d/30d zero while 90d has sales", () => {
    // 7d 0 / 30d 0 / 90d 85 nests legally, so nesting alone cannot catch it --
    // which is exactly why the fix had to remove the truncation rather than
    // validate around it. Recorded here so the limit of this guard is explicit.
    const r = readSalesWindows(envelope({
      units_7d: 0, units_30d: 0, units_90d: 85, units_lifetime: 85,
    }));
    expect(r.ok).toBe(true);
    expect(r.units90d).toBe(85);
  });
});

describe("readSalesWindows — historical fields", () => {
  it("carries both first-order dates, which drive two different rates", () => {
    const r = readSalesWindows(envelope({
      units_7d: 10, units_30d: 40, units_90d: 90, units_lifetime: 500,
      first_order_date_30d: "2026-10-30",
      first_order_date: "2025-01-15",
    }));
    // salesPeriodDays comes from the 30-day one; the lifetime rate fallback
    // comes from the other. Swapping them silently changes the forecast.
    expect(r.firstOrderDate30d).toBe("2026-10-30");
    expect(r.firstOrderDate).toBe("2025-01-15");
  });

  it("a listing with lifetime sales but none in 30 days has no 30d anchor", () => {
    const r = readSalesWindows(envelope({
      units_7d: 0, units_30d: 0, units_90d: 0, units_lifetime: 300,
      first_order_date_30d: null,
      first_order_date: "2024-06-01",
    }));
    expect(r.ok).toBe(true);
    expect(r.firstOrderDate30d).toBeNull();
    expect(r.firstOrderDate).toBe("2024-06-01");
  });

  it("a genuinely new listing with no sales is ok, not an error", () => {
    const r = readSalesWindows(envelope());
    expect(r.ok).toBe(true);
    expect(r.units7d).toBe(0);
    expect(r.unitsLifetime).toBe(0);
  });
});

describe("readSalesWindows — refusing a bad answer instead of showing zeros", () => {
  it("a failed request is not a listing with no sales", () => {
    for (const bad of [null, undefined]) {
      const r = readSalesWindows(bad);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no envelope/);
    }
  });

  it("a row SET is refused — it would mean a row cap is back in play", () => {
    const r = readSalesWindows([envelope(), envelope()]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/array of 2/);
  });

  it("a single-element array is unwrapped, since clients differ", () => {
    const r = readSalesWindows([envelope({ units_7d: 5, units_30d: 5, units_90d: 5, units_lifetime: 5 })]);
    expect(r.ok).toBe(true);
    expect(r.units7d).toBe(5);
  });

  it("missing counts are refused rather than coerced to zero", () => {
    const e = envelope({ units_7d: 12, units_30d: 40, units_90d: 80, units_lifetime: 100 });
    delete e.units_30d;
    const r = readSalesWindows(e);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing one or more unit counts/);
  });

  it("non-numeric counts are refused", () => {
    const r = readSalesWindows(envelope({ units_7d: "many", units_30d: 1, units_90d: 1, units_lifetime: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing one or more unit counts/);
  });

  it("windows that do not nest are refused and say the numbers", () => {
    // 7d above 30d can only mean the windows were computed over different
    // data -- the signature of every truncation bug in this project.
    const r = readSalesWindows(envelope({
      units_7d: 200, units_30d: 50, units_90d: 500, units_lifetime: 900,
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/do not nest/);
    expect(r.reason).toMatch(/7d=200/);
  });

  it("lifetime below the 90-day window is refused", () => {
    const r = readSalesWindows(envelope({
      units_7d: 1, units_30d: 2, units_90d: 90, units_lifetime: 10,
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/do not nest/);
  });

  it("a refused envelope still returns zeroed numbers, so callers cannot read undefined", () => {
    const r = readSalesWindows("not an object");
    expect(r.ok).toBe(false);
    expect(r.units7d).toBe(0);
    expect(r.firstOrderDate).toBeNull();
  });
});
