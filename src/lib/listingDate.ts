/**
 * Parse a listing date that may be a bare DATE rather than a timestamp.
 *
 * `created_listings.date_created` is a Postgres DATE and arrives as
 * "2026-08-23" with no time and no zone. Passing that to `new Date()` does NOT
 * give local midnight: ECMAScript specifies that date-only ISO forms are parsed
 * as UTC, while date-TIME forms without a zone are parsed as local. So the bare
 * form lands on UTC midnight, and every viewer west of UTC renders the
 * PREVIOUS day.
 *
 *   new Date("2026-08-23").toLocaleDateString()  // "Aug 22" in Pacific
 *
 * Reported 2026-08-28 on Synced Inventory: a listing created on the 23rd
 * displayed as "Aug 22, 26". It affected every created-listing row, silently,
 * for anyone not on UTC or east of it.
 *
 * Appending "T00:00:00" opts into the local-time branch of the same spec, which
 * is what a calendar date from Amazon actually means. Timestamps that already
 * carry a zone are passed through untouched.
 *
 * Moved here from SyncedInventory.tsx on 2026-09-15 so the COG on Record page
 * shows the same dates as Synced Inventory from one implementation, not a copy.
 */
export function parseListingDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Synced Inventory's display format: "Sep 15, 26". */
export function formatListingDate(value: string | null | undefined): string | null {
  const d = parseListingDate(value);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : null;
}

/* ------------------------------------------------------------------------- *
 * Created-date resolution, and why it needs a "basis" rather than a date
 *
 * Synced Inventory's "Created" column used to resolve as
 *   inventory.listing_created_at
 *     -> created_listings.date_created      (the real Amazon listing date)
 *     -> created_listings.created_at        (when the ROW was inserted, i.e.
 *                                            when the purchase was added here)
 * and that last fallback silently changes what the column MEANS.
 *
 * Measured 2026-10-21 on the live account:
 *   - inventory.listing_created_at is NULL on all 4,594 rows, so the first
 *     branch never fires at all.
 *   - 3,691 displayed rows resolve from date_created (the real date).
 *   - 709 resolve from created_at -- a purchase-added timestamp.
 *   - 194 have nothing and sorted as epoch 0.
 *
 * The 709 are the problem. created_at runs on average 236 days AFTER
 * date_created, and up to 692 days, because a purchase is typically recorded
 * long after the listing was created. Sorted newest-first they leapfrogged
 * genuinely new listings and sat at the top of the page.
 *
 * So the resolver returns WHICH source it used, not just a date. Callers sort
 * on the basis first and the date second, which puts every real creation date
 * above every purchase-added one instead of interleaving two different
 * meanings on one axis -- and lets the UI label the weaker ones rather than
 * passing them off as creation dates.
 * ------------------------------------------------------------------------- */

export type CreatedDateBasis = "listing" | "purchase_added" | "none";

export interface ResolvedCreatedDate {
  /** The raw value, or null when nothing is known. */
  value: string | null;
  /** Which source it came from. Drives both sorting and labelling. */
  basis: CreatedDateBasis;
}

export interface CreatedDateInputs {
  /** inventory.listing_created_at — Amazon's own listing open date. */
  listingCreatedAt?: string | null;
  /** created_listings.date_created — the listing date we recorded. */
  dateCreated?: string | null;
  /** created_listings.created_at — when the purchase row was inserted here. */
  purchaseAddedAt?: string | null;
}

/** Blank strings count as absent: a "" from a CSV import is not a date. */
function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function resolveCreatedDate(input: CreatedDateInputs): ResolvedCreatedDate {
  if (present(input.listingCreatedAt)) {
    return { value: input.listingCreatedAt, basis: "listing" };
  }
  if (present(input.dateCreated)) {
    return { value: input.dateCreated, basis: "listing" };
  }
  if (present(input.purchaseAddedAt)) {
    // Deliberately NOT "listing": this is when the purchase was added, and
    // conflating the two is the bug this whole block exists to prevent.
    return { value: input.purchaseAddedAt, basis: "purchase_added" };
  }
  return { value: null, basis: "none" };
}

/**
 * Sort order for the basis. This is a FIXED primary key, independent of the
 * asc/desc toggle -- the same way SQL's NULLS LAST keeps unknowns at the end
 * whichever way you sort. "Oldest first" should still not promote a
 * purchase-added date above a real one; the direction only orders rows that
 * share a basis.
 */
const BASIS_RANK: Record<CreatedDateBasis, number> = {
  listing: 0,
  purchase_added: 1,
  none: 2,
};

/**
 * Compare two resolved created-dates: real listing dates first, then
 * purchase-added, then unknown; `direction` orders within each group.
 */
export function compareCreatedDate(
  a: ResolvedCreatedDate,
  b: ResolvedCreatedDate,
  direction: "asc" | "desc",
): number {
  const rankDiff = BASIS_RANK[a.basis] - BASIS_RANK[b.basis];
  if (rankDiff !== 0) return rankDiff;

  const ta = parseListingDate(a.value)?.getTime() ?? 0;
  const tb = parseListingDate(b.value)?.getTime() ?? 0;
  return direction === "asc" ? ta - tb : tb - ta;
}
