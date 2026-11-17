// A period the data does not cover must not report zero.
//
// WHY THIS EXISTS. Reported 2026-11-17, immediately after the null-ASIN fix:
// /tools/unshipped-purchases showed correct Shipped/Received for September 2026
// and "Shipped 0 / Received 0" for every October 2026 purchase. The matching
// was fine (237 of 15,505 lines unmatched, 1.5%, and the sample SKUs were
// numeric invoice codes). There is simply no shipment that recent in
// fba_shipment_items -- so `0` meant "we have no record of this period", while
// the page renders it identically to "Amazon received nothing", which is the
// sentence that sends someone to ask a supplier for money back.
import { describe, it, expect } from 'vitest';
import {
  couldHaveShipmentRecord,
  shipmentCoverage,
  shipmentHeaderDate,
  type ShipmentHeader,
} from '../shipmentCoverage';

const h = (over: Partial<ShipmentHeader> = {}): ShipmentHeader => ({
  ship_date: null,
  received_date: null,
  confirmed_need_by_date: null,
  shipment_name: null,
  created_at: null,
  ...over,
});

describe('shipmentHeaderDate', () => {
  it('prefers ship_date, then received_date', () => {
    expect(shipmentHeaderDate(h({ ship_date: '2026-09-20', received_date: '2026-09-28' })))
      .toBe('2026-09-20');
    expect(shipmentHeaderDate(h({ received_date: '2026-09-28' }))).toBe('2026-09-28');
  });

  it('reads the date the seller typed into the shipment name', () => {
    // The naming convention Amazon itself uses: "FBA shipment (9/14/2026)".
    expect(shipmentHeaderDate(h({ shipment_name: 'Sept restock (9/14/2026) boxes' })))
      .toBe('2026-09-14');
  });

  it('rejects a malformed name date rather than inventing one', () => {
    expect(shipmentHeaderDate(h({ shipment_name: 'bad (13/40/2026)' }))).toBeNull();
  });

  it('falls back to confirmed_need_by_date, and otherwise null', () => {
    expect(shipmentHeaderDate(h({ confirmed_need_by_date: '2026-10-02' }))).toBe('2026-10-02');
    expect(shipmentHeaderDate(h())).toBeNull();
    expect(shipmentHeaderDate(null)).toBeNull();
  });

  it('NEVER treats the local sync time as a shipment date', () => {
    // created_at is when OUR row was written. Using it would make coverage look
    // current exactly when the sync has stopped -- and last_updated_date is the
    // same trap on the server side: it mis-bucketed 144 shipments into April.
    expect(shipmentHeaderDate(h({ created_at: '2026-11-17T04:00:00Z' }))).toBeNull();
  });

  it('takes the day out of a timestamp', () => {
    expect(shipmentHeaderDate(h({ ship_date: '2026-09-20T18:30:00+00:00' }))).toBe('2026-09-20');
  });
});

describe('shipmentCoverage', () => {
  it('reports the dated span, the undated count, and when it last ingested', () => {
    const cov = shipmentCoverage([
      h({ ship_date: '2026-07-04', created_at: '2026-07-06T00:00:00Z' }),
      h({ ship_date: '2026-09-28', created_at: '2026-09-29T00:00:00Z' }),
      h({ created_at: '2026-08-01T00:00:00Z' }),
    ]);
    expect(cov.shipments).toBe(3);
    expect(cov.oldest).toBe('2026-07-04');
    expect(cov.newest).toBe('2026-09-28');
    expect(cov.undated).toBe(1);
    expect(cov.lastIngestedAt).toBe('2026-09-29');
  });

  it('lets an undated header push the POSSIBLE reach forward', () => {
    // A shipment cannot have been created after we wrote its row, so a header
    // with no Amazon date but synced on 30 Oct could be an October shipment.
    // Gating on `newest` alone would excuse October rows that really are short.
    const cov = shipmentCoverage([
      h({ ship_date: '2026-09-28', created_at: '2026-09-29T00:00:00Z' }),
      h({ created_at: '2026-10-30T00:00:00Z' }),
    ]);
    expect(cov.newest).toBe('2026-09-28');
    expect(cov.newestPossible).toBe('2026-10-30');
  });

  it('an empty or missing table yields no coverage at all', () => {
    for (const empty of [[], null, undefined]) {
      const cov = shipmentCoverage(empty);
      expect(cov).toEqual({
        shipments: 0, oldest: null, newest: null,
        undated: 0, newestPossible: null, lastIngestedAt: null,
      });
    }
  });
});

describe('couldHaveShipmentRecord', () => {
  const sept = shipmentCoverage([
    h({ ship_date: '2026-07-04', created_at: '2026-07-06T00:00:00Z' }),
    h({ ship_date: '2026-09-28', created_at: '2026-09-29T00:00:00Z' }),
  ]);

  it('THE REPORTED BUG: an October purchase against September history', () => {
    expect(couldHaveShipmentRecord(sept, '2026-10-14T00:00:00.000Z')).toBe(false);
  });

  it('September purchases are inside coverage, which is why they looked right', () => {
    expect(couldHaveShipmentRecord(sept, '2026-09-20T00:00:00.000Z')).toBe(true);
    // The boundary day itself is covered: a shipment dated 28 Sept can contain
    // a purchase made on 28 Sept.
    expect(couldHaveShipmentRecord(sept, '2026-09-28T00:00:00.000Z')).toBe(true);
  });

  it('fails OPEN on every unknown, so a real shortfall is never hidden', () => {
    // Saying "unknown" where data exists would suppress a genuine claim, which
    // is the more expensive error of the two. So: no coverage, no dated
    // shipment, and an unreadable purchase date all keep the figure visible.
    expect(couldHaveShipmentRecord(null, '2026-10-14')).toBe(true);
    expect(couldHaveShipmentRecord(shipmentCoverage([h(), h()]), '2026-10-14')).toBe(true);
    expect(couldHaveShipmentRecord(sept, null)).toBe(true);
    expect(couldHaveShipmentRecord(sept, 'not a date')).toBe(true);
  });

  it('an undated header synced after the purchase keeps the row honest', () => {
    const withUndated = shipmentCoverage([
      h({ ship_date: '2026-09-28', created_at: '2026-09-29T00:00:00Z' }),
      h({ created_at: '2026-10-30T00:00:00Z' }),
    ]);
    expect(couldHaveShipmentRecord(withUndated, '2026-10-14')).toBe(true);
    // ...but not indefinitely. November is past even that.
    expect(couldHaveShipmentRecord(withUndated, '2026-11-14')).toBe(false);
  });
});

describe('the page consumes the coverage rule', () => {
  it('gates the Shipped/Received cells on it, and pages with a stable order', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const page = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'pages', 'tools', 'UnshippedPurchases.tsx'),
      'utf8',
    );
    expect(page, 'the page no longer computes coverage')
      .toMatch(/shipmentCoverage\(/);
    expect(page, 'the per-row coverage verdict has gone')
      .toMatch(/couldHaveShipmentRecord\(coverage, r\.purchaseDate\)/);
    expect(page, 'the cells no longer distinguish out-of-coverage from zero')
      .toMatch(/!r\.shipmentEvidencePossible/);
    // .range() without .order() does not partition a table: successive pages
    // overlap and some rows are never returned. 15k shipment items over 16
    // pages is exactly where that bites.
    expect(page, 'paged reads have lost their stable ORDER BY')
      .toMatch(/\.order\("id", \{ ascending: true \}\)\s*\r?\n\s*\.range\(from, from \+ size - 1\)/);
  });
});
