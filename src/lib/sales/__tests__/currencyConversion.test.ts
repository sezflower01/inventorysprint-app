import { describe, it, expect } from "vitest";
import {
  getConfirmedSalesOrderRevenueUsd,
  getConfirmedSalesOrderUnitRevenueUsd,
} from "../currencyConversion";

// fx_rates snapshot used in the audit (USD->quote):
//   BRL=5.3766  CAD=1.3872  MXN=17.9028
const FX: Record<string, number> = {
  BR: 5.3766,
  CA: 1.3872,
  MX: 17.9028,
  US: 1,
};

// toUsd(amount, marketplace) - mirrors live behavior: amount / fxRate
const toUsd = (amount: number, mp?: string | null) => {
  const r = FX[String(mp || "US").toUpperCase()] ?? 1;
  return amount / r;
};

// oneUsd helper used by guard: toUsd(1, mp) = 1/fxRate, so fxRate = 1/oneUsd
// (callers stay outside the helper - tests just need toUsd)

describe("AUDIT §14 - BR confirmed revenue must NOT be re-divided by FX", () => {
  // Real incident orders from the production scan. sold_price/total_sale_amount
  // were written in USD by sync-sales-orders. Reader must return them as-is.

  it("702-8744704-5319432 (BR, order_total_pending) returns stored USD", () => {
    const row = {
      marketplace: "BR",
      quantity: 1,
      sold_price: 33.97,
      total_sale_amount: 33.97,
      estimated_price: null,
      price_source: "order_total_pending",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(33.97, 2);
    expect(getConfirmedSalesOrderUnitRevenueUsd(row, toUsd)).toBeCloseTo(33.97, 2);
  });

  it("702-6403753-5454661 (BR, orders_itemprice) returns stored USD", () => {
    const row = {
      marketplace: "BR",
      quantity: 1,
      sold_price: 32.86,
      total_sale_amount: 32.86,
      estimated_price: 22.99, // typical: estimate differs from confirmed USD price
      price_source: "orders_itemprice",
    };
    // Pre-fix: startsWith branch -> divided by 5.3766 -> ~$6.11.
    // Post-fix: branch removed, ratio 32.86/22.99=1.43 escapes 0.92-1.08
    // guard, magnitude 32.86 < BR threshold(120) -> stored USD returned.
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(32.86, 2);
  });

  it("701-0363848-6419454 (BR, financial_events) returns stored USD (trusted)", () => {
    const row = {
      marketplace: "BR",
      quantity: 1,
      sold_price: 34.3128,
      total_sale_amount: 34.3128,
      estimated_price: 22.99,
      price_source: "financial_events",
      price_calc_mode: "listings_api",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(34.31, 2);
  });
});

describe("AUDIT §14 - CA parity (USD on read, no re-division)", () => {
  it("CA orders_itemprice typical row stays USD", () => {
    const row = {
      marketplace: "CA",
      quantity: 1,
      sold_price: 28.5,
      total_sale_amount: 28.5,
      price_source: "orders_itemprice",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(28.5, 2);
  });

  it("CA order_total_pending typical row stays USD", () => {
    const row = {
      marketplace: "CA",
      quantity: 1,
      sold_price: 26.0,
      total_sale_amount: 26.0,
      price_source: "order_total_pending",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(26.0, 2);
  });
});

describe("AUDIT §14 - MX defensive guards still catch legacy native rows", () => {
  it("MX small USD row (orders_api $28) stays USD", () => {
    const row = {
      marketplace: "MX",
      quantity: 1,
      sold_price: 28.37,
      total_sale_amount: 28.37,
      price_source: "orders_api",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(28.37, 2);
  });

  it("MX legacy native row (sold=est=native MXN ratio≈1) still converts", () => {
    // Historical broken row: both sold_price and estimated_price stored native.
    const row = {
      marketplace: "MX",
      quantity: 1,
      sold_price: 470.71,
      total_sale_amount: 470.71,
      estimated_price: 470.71,
      price_source: "orders_itemprice",
    };
    // Magnitude OR ratio≈1 guard triggers -> converted: 470.71 / 17.9028 ≈ 26.29
    const usd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    expect(usd).toBeLessThan(50);
    expect(usd).toBeGreaterThan(20);
  });

  it("MX large outlier ($836) above magnitude threshold still converts", () => {
    const row = {
      marketplace: "MX",
      quantity: 1,
      sold_price: 836.23,
      total_sale_amount: 836.23,
      price_source: "orders_itemprice",
    };
    const usd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    expect(usd).toBeCloseTo(836.23 / 17.9028, 1);
  });
});

describe("AUDIT §14 - US untouched", () => {
  it("US orders_itemprice returns raw", () => {
    const row = {
      marketplace: "US",
      quantity: 2,
      sold_price: 19.99,
      total_sale_amount: 39.98,
      price_source: "orders_itemprice",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(39.98, 2);
  });
});

describe("pending lowball guard is US-only (2026-10-19 regression)", () => {
  // The guard was written and validated for US rows -- its own comment says
  // "Validated against 900 recent ... Pending + suspect-sourced US rows" --
  // but it was never scoped to US and ran BEFORE the marketplace === "US"
  // short-circuit. On non-US it compares a USD `raw` against a NATIVE
  // estimated_price, so `raw < est * 0.85` is true for essentially every
  // healthy row, and it then returned estimated_price UNCONVERTED.
  //
  // Live case: MX order 701-8676794-7473022, Amazon MX$669.62, correctly
  // stored as 36.43 USD with estimated_price 669.62 native. The report showed
  // $669.62 -- an 18x overstatement of a perfectly good row.
  const mxHealthyPending = {
    marketplace: "MX",
    quantity: 1,
    sold_price: 36.43,
    total_sale_amount: 36.43,
    estimated_price: 669.62, // NATIVE MXN, by contract
    price_source: "orders_itemprice", // on the suspect list
    order_status: "Pending",
    order_date: new Date().toISOString().slice(0, 10),
  };

  it("does NOT swap a correct MX USD revenue for the native estimate", () => {
    const usd = getConfirmedSalesOrderRevenueUsd(mxHealthyPending, toUsd);
    expect(usd).toBeCloseTo(36.43, 2);
    expect(usd).not.toBeCloseTo(669.62, 2);
  });

  it("holds for CA too", () => {
    const ca = {
      ...mxHealthyPending,
      marketplace: "CA",
      sold_price: 14.38,
      total_sale_amount: 14.38,
      estimated_price: 20.36,
    };
    expect(getConfirmedSalesOrderRevenueUsd(ca, toUsd)).toBeCloseTo(14.38, 2);
  });

  it("still fires for the US case it was built for", () => {
    // The original finding: a 10-unit US order showing $150.57 while still
    // Pending when the seller's own listing price made $215.10 the real total.
    const us = {
      marketplace: "US",
      quantity: 10,
      sold_price: 15.057,
      total_sale_amount: 150.57,
      estimated_price: 21.51,
      price_source: "orders_itemprice",
      order_status: "Pending",
      order_date: new Date().toISOString().slice(0, 10),
    };
    expect(getConfirmedSalesOrderRevenueUsd(us, toUsd)).toBeCloseTo(215.1, 2);
  });

  it("leaves a SETTLED non-US row alone", () => {
    const settled = { ...mxHealthyPending, order_status: "Shipped" };
    expect(getConfirmedSalesOrderRevenueUsd(settled, toUsd)).toBeCloseTo(36.43, 2);
  });
});
