import { describe, expect, it } from "vitest";
import {
  POSTGREST_MAX_ROWS,
  parseMediaEnvelope,
  parseSalesEnvelope,
} from "../asinEnrichment";

/**
 * Build a jsonb envelope the way get_repricer_asin_sales_json does, with `n`
 * ASINs. `rows` is deliberately derived from the payload so a test that wants
 * them to disagree has to say so explicitly.
 */
function salesEnvelope(n: number, opts: { rows?: number; truncated?: boolean } = {}) {
  const asins: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const asin = `B${String(i).padStart(9, "0")}`;
    asins[asin] = { today: i % 3, d7: i % 7, d30: i % 30, life: i + 1, first: "2025-01-23", last: "2026-11-19" };
  }
  return {
    generated_at: "2026-11-19T12:00:00+00:00",
    rows: opts.rows ?? n,
    truncated: opts.truncated ?? false,
    asins: opts.truncated ? null : asins,
  };
}

describe("parseSalesEnvelope", () => {
  it("REGRESSION: 1,500 ASINs all survive -- the shape that used to be cut at 1,000", () => {
    const res = parseSalesEnvelope(salesEnvelope(1500));
    expect(res.ok).toBe(true);

    // The exact number that mattered: the old RETURNS TABLE version reported
    // 1000 here and lost 500 ASINs with no error.
    expect(Object.keys(res.value!.salesTodayMap)).toHaveLength(1500);
    expect(Object.keys(res.value!.sales7Map)).toHaveLength(1500);
    expect(Object.keys(res.value!.salesMap)).toHaveLength(1500);
    expect(Object.keys(res.value!.historicalSalesMap)).toHaveLength(1500);
    expect(res.rows).toBe(1500);

    // An ASIN well past the cap carries real figures, not zeros.
    expect(res.value!.historicalSalesMap["B000001400"]).toEqual({
      totalUnits: 1401,
      earliestDate: "2025-01-23",
    });
  });

  it("THE DEFECT: an array of exactly 1,000 rows is refused and named as the cap", () => {
    const capped = Array.from({ length: POSTGREST_MAX_ROWS }, (_, i) => ({
      asin: `B${String(i).padStart(9, "0")}`,
      units_today: 1,
      units_7d: 1,
      units_30d: 1,
      units_lifetime: 1,
      first_order_date: "2025-01-23",
    }));
    const res = parseSalesEnvelope(capped);
    expect(res.ok).toBe(false);
    expect(res.rows).toBe(POSTGREST_MAX_ROWS);
    expect(res.reason).toMatch(/TRUNCATED/);
    expect(res.reason).toMatch(/20261119060000/);
  });

  it("any array shape is refused, because only the capped function returns one", () => {
    const res = parseSalesEnvelope([{ asin: "B000000001", units_lifetime: 4 }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/set-returning function is still in place/);
  });

  it("a legitimate 1,000 ASINs is ACCEPTED -- the guard must not false-positive", () => {
    // Someone really can have exactly 1,000 ASINs. Rejecting that number on
    // sight would strand them on the slow path forever, so the envelope's own
    // count is what decides, not the magic number.
    const res = parseSalesEnvelope(salesEnvelope(POSTGREST_MAX_ROWS));
    expect(res.ok).toBe(true);
    expect(Object.keys(res.value!.salesTodayMap)).toHaveLength(POSTGREST_MAX_ROWS);
  });

  it("truncated: true is refused and reports the true count the server withheld", () => {
    const res = parseSalesEnvelope(salesEnvelope(0, { rows: 73_000, truncated: true }));
    expect(res.ok).toBe(false);
    expect(res.rows).toBe(73_000);
    expect(res.reason).toMatch(/73000/);
    expect(res.reason).toMatch(/paged scan/);
  });

  it("received must equal the count the server reported", () => {
    const res = parseSalesEnvelope(salesEnvelope(900, { rows: 1200 }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/received 900 ASINs but the server counted 1200/);
  });

  it("a lifetime count with no first-sale date is not recorded as history", () => {
    const res = parseSalesEnvelope({
      rows: 2,
      truncated: false,
      asins: {
        B000000001: { today: 0, d7: 0, d30: 0, life: 9, first: null },
        B000000002: { today: 0, d7: 0, d30: 0, life: 9, first: "2026-01-01" },
      },
    });
    expect(res.ok).toBe(true);
    // Without a date, dividing by days-since would read as "9 sold in 1 day".
    expect(res.value!.historicalSalesMap.B000000001).toBeUndefined();
    expect(res.value!.historicalSalesMap.B000000002.totalUnits).toBe(9);
    // The row still contributes its windowed counts.
    expect(res.value!.salesTodayMap.B000000001).toBe(0);
  });

  it("keys are normalised, so the maps join against the client's ASINs", () => {
    const res = parseSalesEnvelope({
      rows: 1,
      truncated: false,
      asins: { " b00-8vrfr yi ": { today: 2, d7: 2, d30: 2, life: 2, first: "2025-02-02" } },
    });
    expect(res.ok).toBe(true);
    expect(res.value!.salesTodayMap.B008VRFRYI).toBe(2);
  });

  it("empty and malformed responses are refused, not read as zero sales", () => {
    for (const bad of [null, undefined, "nope", 42, { rows: 5, truncated: false }]) {
      const res = parseSalesEnvelope(bad);
      expect(res.ok).toBe(false);
    }
  });

  it("an empty but valid result is accepted as genuinely empty", () => {
    const res = parseSalesEnvelope({ rows: 0, truncated: false, asins: {} });
    expect(res.ok).toBe(true);
    expect(Object.keys(res.value!.salesTodayMap)).toHaveLength(0);
  });
});

describe("parseMediaEnvelope", () => {
  it("REGRESSION: 1,500 ASINs of media all survive", () => {
    const asins: Record<string, unknown> = {};
    for (let i = 0; i < 1500; i++) {
      asins[`B${String(i).padStart(9, "0")}`] = { title: `Item ${i}`, image: `https://img/${i}.jpg` };
    }
    const res = parseMediaEnvelope({ rows: 1500, truncated: false, asins });
    expect(res.ok).toBe(true);
    expect(Object.keys(res.value!)).toHaveLength(1500);
    expect(res.value!.B000001400).toEqual({ title: "Item 1400", image_url: "https://img/1400.jpg" });
  });

  it("each field is independent: a title with no image, and an image with no title", () => {
    const res = parseMediaEnvelope({
      rows: 2,
      truncated: false,
      asins: {
        B000000001: { title: "Has title only", image: null },
        B000000002: { title: null, image: "https://img/2.jpg" },
      },
    });
    expect(res.ok).toBe(true);
    expect(res.value!.B000000001).toEqual({ title: "Has title only", image_url: undefined });
    expect(res.value!.B000000002).toEqual({ title: undefined, image_url: "https://img/2.jpg" });
  });

  it("an array of exactly 1,000 is refused as the cap", () => {
    const capped = Array.from({ length: POSTGREST_MAX_ROWS }, (_, i) => ({
      asin: `B${String(i).padStart(9, "0")}`,
      title: "x",
      image_url: "y",
    }));
    const res = parseMediaEnvelope(capped);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/TRUNCATED/);
  });

  it("an empty string is treated as absent, not as a blank title", () => {
    const res = parseMediaEnvelope({
      rows: 1,
      truncated: false,
      asins: { B000000001: { title: "", image: "" } },
    });
    expect(res.ok).toBe(true);
    expect(res.value!.B000000001).toEqual({ title: undefined, image_url: undefined });
  });
});
