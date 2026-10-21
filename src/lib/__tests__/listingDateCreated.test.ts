import { describe, it, expect } from "vitest";
import {
  resolveCreatedDate,
  compareCreatedDate,
  type ResolvedCreatedDate,
} from "../listingDate";

const L = (v: string | null): ResolvedCreatedDate => ({ value: v, basis: "listing" });
const P = (v: string | null): ResolvedCreatedDate => ({ value: v, basis: "purchase_added" });
const N: ResolvedCreatedDate = { value: null, basis: "none" };

describe("resolveCreatedDate", () => {
  it("prefers inventory.listing_created_at", () => {
    expect(resolveCreatedDate({
      listingCreatedAt: "2026-01-05",
      dateCreated: "2025-03-03",
      purchaseAddedAt: "2026-10-20T10:00:00Z",
    })).toEqual({ value: "2026-01-05", basis: "listing" });
  });

  it("falls to created_listings.date_created, still a real listing date", () => {
    expect(resolveCreatedDate({
      dateCreated: "2025-03-03",
      purchaseAddedAt: "2026-10-20T10:00:00Z",
    })).toEqual({ value: "2025-03-03", basis: "listing" });
  });

  it("THE BUG: a purchase-added timestamp is marked, not passed off as a listing date", () => {
    expect(resolveCreatedDate({
      purchaseAddedAt: "2026-10-20T10:00:00Z",
    })).toEqual({ value: "2026-10-20T10:00:00Z", basis: "purchase_added" });
  });

  it("reports nothing as 'none' rather than a fake epoch date", () => {
    expect(resolveCreatedDate({})).toEqual({ value: null, basis: "none" });
    expect(resolveCreatedDate({ listingCreatedAt: null, dateCreated: null, purchaseAddedAt: null }))
      .toEqual({ value: null, basis: "none" });
  });

  it("treats blank and whitespace-only strings as absent", () => {
    expect(resolveCreatedDate({ dateCreated: "", purchaseAddedAt: "2026-10-20" }).basis)
      .toBe("purchase_added");
    expect(resolveCreatedDate({ dateCreated: "   ", purchaseAddedAt: "" }).basis).toBe("none");
  });
});

describe("compareCreatedDate: real dates first, purchase-added at the END", () => {
  it("puts a real date above a NEWER purchase-added one", () => {
    // The exact regression: created_at runs ~236 days later, so a
    // purchase-added row used to leapfrog genuinely new listings.
    expect(compareCreatedDate(L("2026-01-05"), P("2026-10-20"), "desc")).toBeLessThan(0);
    expect(compareCreatedDate(P("2026-10-20"), L("2026-01-05"), "desc")).toBeGreaterThan(0);
  });

  it("keeps that grouping when sorting ASCENDING too", () => {
    // The basis is a fixed primary key, like SQL's NULLS LAST: oldest-first
    // must not promote a purchase-added date above a real one either.
    expect(compareCreatedDate(L("2026-01-05"), P("2020-01-01"), "asc")).toBeLessThan(0);
    expect(compareCreatedDate(P("2020-01-01"), L("2026-01-05"), "asc")).toBeGreaterThan(0);
  });

  it("puts unknowns last, after even purchase-added", () => {
    // purchase-added sorts BEFORE unknown, both directions
    expect(compareCreatedDate(P("2020-01-01"), N, "desc")).toBeLessThan(0);
    expect(compareCreatedDate(N, P("2020-01-01"), "desc")).toBeGreaterThan(0);
    expect(compareCreatedDate(P("2020-01-01"), N, "asc")).toBeLessThan(0);
    // and a real date beats unknown whichever way you sort
    expect(compareCreatedDate(N, L("2020-01-01"), "asc")).toBeGreaterThan(0);
    expect(compareCreatedDate(N, L("2020-01-01"), "desc")).toBeGreaterThan(0);
  });

  it("orders by date within a group, honouring the direction", () => {
    expect(compareCreatedDate(L("2026-10-20"), L("2026-01-05"), "desc")).toBeLessThan(0);
    expect(compareCreatedDate(L("2026-10-20"), L("2026-01-05"), "asc")).toBeGreaterThan(0);
    expect(compareCreatedDate(P("2026-10-20"), P("2026-01-05"), "desc")).toBeLessThan(0);
  });

  it("sorts a realistic mixed page the way the seller asked", () => {
    const rows = [
      { id: "purchase-added-today", c: P("2026-10-21T09:00:00Z") },
      { id: "real-old", c: L("2024-02-02") },
      { id: "unknown", c: N },
      { id: "real-newest", c: L("2026-10-20") },
      { id: "purchase-added-older", c: P("2026-05-01T09:00:00Z") },
      { id: "real-middle", c: L("2026-03-15") },
    ];
    const order = [...rows]
      .sort((a, b) => compareCreatedDate(a.c, b.c, "desc"))
      .map((r) => r.id);

    expect(order).toEqual([
      "real-newest",
      "real-middle",
      "real-old",
      "purchase-added-today",
      "purchase-added-older",
      "unknown",
    ]);
  });

  it("is a consistent comparator (no ordering that depends on input order)", () => {
    const all = [L("2026-10-20"), L("2024-01-01"), P("2026-10-21"), P("2020-01-01"), N];
    for (const dir of ["asc", "desc"] as const) {
      for (const a of all) {
        for (const b of all) {
          const ab = compareCreatedDate(a, b, dir);
          const ba = compareCreatedDate(b, a, dir);
          // Summed rather than negated: Math.sign(0) is +0 and -Math.sign(0)
          // is -0, which Object.is treats as different.
          expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        }
      }
    }
  });
});
