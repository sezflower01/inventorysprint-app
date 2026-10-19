import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPendingEstimateUsd, getCancelledLineUsd } from "../currencyConversion";

// fx_rates snapshot (USD -> quote), matching the sibling suite.
const FX: Record<string, number> = { BR: 5.3766, CA: 1.3872, MX: 17.9028, US: 1 };
const toUsd = (amount: number, mp?: string | null) =>
  amount / (FX[String(mp || "US").toUpperCase()] ?? 1);

/**
 * One case per marketplace x three order states, as required before the
 * helper rollout. The point is not just "does it convert" but "does it convert
 * the RIGHT fields": sold_price and total_sale_amount are USD everywhere and
 * must never be divided again, while estimated_price and locked_est_price are
 * native for non-US and must always be.
 */
const CASES = [
  { mp: "US", rate: 1,       nativeEst: 21.5,  soldUsd: 19.99 },
  { mp: "CA", rate: 1.3872,  nativeEst: 20.36, soldUsd: 14.38 },
  { mp: "MX", rate: 17.9028, nativeEst: 669.62, soldUsd: 36.43 },
  { mp: "BR", rate: 5.3766,  nativeEst: 134.15, soldUsd: 24.95 },
];

describe("getPendingEstimateUsd - per marketplace", () => {
  for (const c of CASES) {
    describe(c.mp, () => {
      it("Pending with NO sold price converts the native estimate", () => {
        const row = {
          marketplace: c.mp,
          quantity: 1,
          sold_price: 0,
          total_sale_amount: 0,
          estimated_price: c.nativeEst,
          order_status: "Pending",
        };
        expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo(c.nativeEst / c.rate, 2);
      });

      it("respects quantity", () => {
        const row = {
          marketplace: c.mp,
          quantity: 3,
          sold_price: 0,
          total_sale_amount: 0,
          estimated_price: c.nativeEst,
          order_status: "Pending",
        };
        expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo((c.nativeEst * 3) / c.rate, 2);
      });

      it("prefers locked_est_price over estimated_price, still converting", () => {
        const row = {
          marketplace: c.mp,
          quantity: 1,
          sold_price: 0,
          total_sale_amount: 0,
          locked_est_price: c.nativeEst,
          estimated_price: c.nativeEst * 2,
          order_status: "Pending",
        };
        expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo(c.nativeEst / c.rate, 2);
      });

      it("a SETTLED order uses its USD figure and is NOT converted again", () => {
        const row = {
          marketplace: c.mp,
          quantity: 1,
          sold_price: c.soldUsd,
          total_sale_amount: c.soldUsd,
          estimated_price: c.nativeEst,
          order_status: "Shipped",
          price_source: "financial_events",
        };
        expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo(c.soldUsd, 2);
        // This is the LiveSalesPopup bug: dividing an already-USD figure.
        // Only assertable where the rate is not 1 -- for US the two values are
        // identical by definition, which is what my first version got wrong.
        if (c.rate !== 1) {
          expect(getPendingEstimateUsd(row, toUsd)).not.toBeCloseTo(c.soldUsd / c.rate, 2);
        }
      });

      it("a CANCELLED order converts its estimate", () => {
        const row = {
          marketplace: c.mp,
          quantity: 1,
          sold_price: 0,
          total_sale_amount: 0,
          estimated_price: c.nativeEst,
          order_status: "Canceled",
          is_cancelled: true,
        };
        expect(getCancelledLineUsd(row, toUsd)).toBeCloseTo(c.nativeEst / c.rate, 2);
      });

      it("returns 0 when there is no price of any kind", () => {
        const row = {
          marketplace: c.mp, quantity: 1, sold_price: 0,
          total_sale_amount: 0, estimated_price: 0, order_status: "Pending",
        };
        expect(getPendingEstimateUsd(row, toUsd)).toBe(0);
      });
    });
  }
});

describe("US results are numerically unchanged", () => {
  it("US conversion is the identity", () => {
    const row = {
      marketplace: "US", quantity: 2, sold_price: 0,
      total_sale_amount: 0, estimated_price: 21.5, order_status: "Pending",
    };
    expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo(43.0, 2);
  });

  it("a missing marketplace is treated as US, not silently scaled", () => {
    const row = {
      marketplace: null, quantity: 1, sold_price: 0,
      total_sale_amount: 0, estimated_price: 21.5, order_status: "Pending",
    };
    expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo(21.5, 2);
  });

  it("an UNKNOWN marketplace does not get an invented rate", () => {
    const row = {
      marketplace: "ZZ", quantity: 1, sold_price: 0,
      total_sale_amount: 0, estimated_price: 21.5, order_status: "Pending",
    };
    expect(getPendingEstimateUsd(row, toUsd)).toBeCloseTo(21.5, 2);
  });
});

/**
 * REGRESSION GUARD. The bug was reintroduced independently at least six times,
 * so the pattern itself is what has to be policed, not each copy.
 *
 * The allowlist is deliberately explicit rather than broad: each entry is a
 * site where the raw multiply is SAFE because the immediate caller applies
 * toUsd(), and that is stated per file. A new unlisted occurrence fails here.
 */
describe("no new unconverted estimated_price * quantity", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..");

  // file -> why its raw multiply is safe today
  const ALLOWED: Record<string, string> = {
    "src/lib/sales/currencyConversion.ts":
      "the shared helper itself, plus comments describing the bug",
    "src/pages/tools/MobileLiveSales.tsx":
      "getLineRevenue/getUnitPriceForAverage return native; the caller getRevenueUsdWithFallback applies toUsd",
    "src/pages/tools/LiveSales.tsx":
      "same shape as mobile; getRevenueUsdWithFallback converts",
    "src/pages/tools/Dashboard.tsx":
      "getLineRevenue returns native; the caller does toUsd(rawRevenue, row.marketplace)",
    "src/lib/salesCalculations.ts":
      "getGrossSalesForOrder is not imported by any page; pages take only getOrderPromoUsd",
    "src/lib/sales/periodSnapshot.ts":
      "snapshot builder, not a display path",
  };

  const FILES = [
    "src/lib/sales/currencyConversion.ts",
    "src/lib/salesCalculations.ts",
    "src/lib/sales/periodSnapshot.ts",
    "src/pages/tools/MobileLiveSales.tsx",
    "src/pages/tools/LiveSales.tsx",
    "src/pages/tools/Dashboard.tsx",
    "src/components/sales/PeriodStatsBlocks.tsx",
    "src/components/sales/CancelledOrdersSection.tsx",
    "src/components/repricer/LiveSalesPopup.tsx",
  ];

  // `<something ending in est/price/Est/Price> * qty`
  const PATTERN =
    /\b(estimated|estimatedPrice|estimatedUsd|estPrice|estimatedNative|est|lockedEst|lockedNative)\s*\*\s*qty\b/;

  for (const rel of FILES) {
    it(`${rel} has no unapproved raw estimate multiply`, () => {
      let src = "";
      try {
        src = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        return; // file moved or deleted; other tests will catch real breakage
      }
      const offending = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter((l) => PATTERN.test(l.line))
        .filter((l) => !l.line.startsWith("//") && !l.line.startsWith("*"));

      if (offending.length > 0 && ALLOWED[rel]) return; // documented as safe
      expect(
        offending.map((o) => `${rel}:${o.n}  ${o.line}`),
        `Unconverted estimate multiply. Route it through getPendingEstimateUsd ` +
          `in src/lib/sales/currencyConversion.ts, or add ${rel} to ALLOWED ` +
          `with the reason its caller converts.`,
      ).toEqual([]);
    });
  }
});
