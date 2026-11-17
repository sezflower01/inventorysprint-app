/**
 * How far back -- and how far FORWARD -- the FBA shipment history actually reaches.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Reported 2026-11-17: after the null-ASIN fix, /tools/unshipped-purchases
 * showed correct Shipped/Received figures for September 2026 purchases and
 * "Shipped 0 / Received 0 / Shipments —" for every October 2026 purchase.
 *
 * Nothing is wrong with the matching. 237 of 15,505 lines were unmatched --
 * 1.5%, and the sample SKUs were numeric supplier/invoice codes, not merchant
 * SKUs. The October rows have no shipment lines because `fba_shipment_items`
 * CONTAINS NO SHIPMENT THAT RECENT. A purchase cannot be matched to a shipment
 * that was never ingested.
 *
 * So the page was printing 0 for a period its data does not cover -- the same
 * one-state-two-jobs bug as the null-ASIN skip, one level up. `0` meant both
 * "Amazon recorded nothing" and "we have no record of this period". The first
 * is a supplier shortfall worth a phone call; the second is a stale sync.
 *
 * ── WHICH DATE ────────────────────────────────────────────────────────────
 *
 * Mirrors the COALESCE chain in get_shipment_accounting_period, with the same
 * deliberate exclusion: `last_updated_date` is NOT a shipment date. Amazon
 * returns the API call timestamp there, which mis-bucketed 144 shipments into
 * April 2026 (see 20260425042839).
 *
 * `created_at` is excluded too, and that one is specific to coverage: it is
 * when OUR sync wrote the row, so a header with no Amazon date at all would
 * report today and make coverage look current precisely when it is not. Those
 * rows are counted as `undated` and reported separately instead -- the point of
 * this module is to not overstate what is known.
 */

export type ShipmentHeader = {
  ship_date?: string | null;
  received_date?: string | null;
  confirmed_need_by_date?: string | null;
  shipment_name?: string | null;
  /** When OUR sync first wrote the row. Never a shipment date -- see below. */
  created_at?: string | null;
};

export type ShipmentCoverage = {
  /** Headers seen, dated or not. 0 means the shipment table did not load. */
  shipments: number;
  /** yyyy-mm-dd of the oldest / newest shipment carrying a real Amazon date. */
  oldest: string | null;
  newest: string | null;
  /**
   * Headers with no usable Amazon date. These are why `newest` is a FLOOR on
   * coverage and not a ceiling: an undated header could be newer than it.
   */
  undated: number;
  /**
   * The furthest forward coverage could POSSIBLY reach: `newest`, or the day an
   * undated header was first synced, whichever is later.
   *
   * A shipment cannot have been created after we wrote the row for it, so an
   * undated header synced on 30 Oct could be an October shipment. This is the
   * value the UI gates on, so that "no data for this period" is only ever said
   * when no header -- dated or not -- could be describing it.
   */
  newestPossible: string | null;
  /**
   * The day the newest header was first written locally, over ALL headers.
   *
   * This is the answer to "is the sync stale?" on its own: if the most recent
   * shipment row was inserted seven weeks ago, no October shipment has been
   * ingested, whatever the dated range says.
   */
  lastIngestedAt: string | null;
};

/** MM/DD/YYYY inside parentheses, as Amazon's own shipment names carry it. */
const NAME_DATE = /\((\d{1,2})\/(\d{1,2})\/(\d{4})/;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

function asDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = ISO_DAY.exec(String(value));
  return m ? m[0] : null;
}

/**
 * The one date a shipment happened on, or null when nothing real says.
 *
 * Order matters and matches the server: shipped, then received, then the date
 * the seller typed into the shipment name, then the need-by date they promised
 * Amazon. Each is weaker evidence than the one before it, and all four beat
 * guessing.
 */
export function shipmentHeaderDate(h: ShipmentHeader | null | undefined): string | null {
  if (!h) return null;
  const direct = asDay(h.ship_date) || asDay(h.received_date);
  if (direct) return direct;
  const m = h.shipment_name ? NAME_DATE.exec(h.shipment_name) : null;
  if (m) {
    const [, mm, dd, yyyy] = m;
    const month = Number(mm);
    const day = Number(dd);
    // Amazon writes these by hand into shipment names; a malformed one must not
    // become a real-looking date.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return asDay(h.confirmed_need_by_date);
}

export function shipmentCoverage(
  headers: ShipmentHeader[] | null | undefined,
): ShipmentCoverage {
  let oldest: string | null = null;
  let newest: string | null = null;
  let undated = 0;
  let shipments = 0;
  let lastIngestedAt: string | null = null;
  let newestUndatedIngest: string | null = null;

  for (const h of headers ?? []) {
    shipments++;
    const ingested = asDay(h?.created_at);
    if (ingested && (!lastIngestedAt || ingested > lastIngestedAt)) lastIngestedAt = ingested;

    const day = shipmentHeaderDate(h);
    if (!day) {
      undated++;
      if (ingested && (!newestUndatedIngest || ingested > newestUndatedIngest)) {
        newestUndatedIngest = ingested;
      }
      continue;
    }
    // ISO day strings compare correctly as strings; no Date objects, so no
    // timezone can shift a boundary by a day.
    if (!oldest || day < oldest) oldest = day;
    if (!newest || day > newest) newest = day;
  }

  const newestPossible = [newest, newestUndatedIngest]
    .filter((d): d is string => !!d)
    .reduce<string | null>((a, b) => (!a || b > a ? b : a), null);

  return { shipments, oldest, newest, undated, newestPossible, lastIngestedAt };
}

/**
 * Could a purchase made on `purchaseDate` possibly have a shipment record?
 *
 * Fail-OPEN on purpose. This gates whether the UI replaces a 0 with "no data",
 * and claiming "no data" where data exists would hide a real supplier
 * shortfall -- the more expensive of the two mistakes. So anything short of a
 * definite "the history stops before this purchase" returns true:
 *
 *   - no coverage computed, or not one header carries any date -> true
 *   - purchase date unreadable -> true
 *
 * Note it gates on `newestPossible`, not `newest`, so an undated header synced
 * after the purchase keeps the row honest rather than silently excused.
 */
export function couldHaveShipmentRecord(
  coverage: ShipmentCoverage | null | undefined,
  purchaseDate: string | null | undefined,
): boolean {
  if (!coverage || !coverage.newestPossible) return true;
  const day = asDay(purchaseDate);
  if (!day) return true;
  return day <= coverage.newestPossible;
}
