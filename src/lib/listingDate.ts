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
