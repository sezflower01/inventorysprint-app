// Shipment lines must reach the product they shipped.
//
// WHY THIS EXISTS. Reported 2026-11-17: /tools/unshipped-purchases showed
// "Shipped 0 / Received 0" and an empty Shipments column on every row, across
// 33 ASINs that had sold and were holding stock. The aggregation sat inside a
// component useMemo and dropped every line whose ASIN was null:
//
//     const asin = it.asin;
//     if (!asin) continue;
//
// fba_shipment_items.asin is nullable and is null on write -- Amazon's
// InboundShipmentItem payload has no ASIN field at all -- so that `continue`
// discarded the normal case. The page's Missing and Value columns rest on
// those totals, and the page's output is "contact your supplier about money".
import { describe, it, expect } from 'vitest';
import {
  attributeShipmentItems,
  buildAsinBySku,
  skuKey,
  type ShipmentLine,
} from '../shipmentAttribution';

/** Two ASINs from the report, with SYNTHETIC SKUs -- the real merchant SKUs
 * are account data and the repo is public. The shape is what matters: these
 * are Amazon-generated SKUs, which is the format the matching has to survive. */
const STANLEY = { asin: 'B0DTNFQDDB', sku: 'AAA-BBB-0001' };
const NASCAR = { asin: 'B0H8QLSNPP', sku: 'CCC-DDD-0002' };

function line(over: Partial<ShipmentLine>): ShipmentLine {
  return {
    asin: null,
    seller_sku: null,
    shipment_id: 'FBA1ABCDEFG',
    quantity_shipped: 0,
    quantity_received: 0,
    ...over,
  };
}

describe('buildAsinBySku', () => {
  it('prefers inventory, which is Amazon’s own mapping', () => {
    // If the two sources disagree the inventory row wins: it describes stock
    // Amazon has actually held under that SKU.
    const map = buildAsinBySku(
      [{ sku: STANLEY.sku, asin: STANLEY.asin }],
      [{ sku: STANLEY.sku, asin: 'B0WRONG001' }],
    );
    expect(map.get(STANLEY.sku)).toBe(STANLEY.asin);
  });

  it('falls back to created_listings for a SKU Amazon no longer lists', () => {
    const map = buildAsinBySku([], [{ sku: NASCAR.sku, asin: NASCAR.asin }]);
    expect(map.get(NASCAR.sku)).toBe(NASCAR.asin);
  });

  it('normalizes case and padding, because the sources do not agree on them', () => {
    const map = buildAsinBySku([{ sku: '  aaa-bbb-0001 ', asin: STANLEY.asin }], []);
    expect(map.get(skuKey('AAA-BBB-0001'))).toBe(STANLEY.asin);
  });

  it('ignores rows with no SKU or no ASIN rather than storing a blank key', () => {
    const map = buildAsinBySku(
      [{ sku: null, asin: STANLEY.asin }, { sku: STANLEY.sku, asin: null }],
      [],
    );
    expect(map.size).toBe(0);
  });
});

describe('attributeShipmentItems', () => {
  it('counts a line whose own ASIN column is null -- the case that was dropped', () => {
    // THE BUG, as a test. This is the shape sync-fba-shipments actually writes.
    const asinBySku = buildAsinBySku([{ sku: STANLEY.sku, asin: STANLEY.asin }], []);
    const { byAsin, unmatched } = attributeShipmentItems(
      [line({ asin: null, seller_sku: STANLEY.sku, quantity_shipped: 115, quantity_received: 115 })],
      asinBySku,
    );

    expect(byAsin.get(STANLEY.asin)).toMatchObject({ shipped: 115, received: 115 });
    expect(unmatched.lines).toBe(0);
  });

  it('uses the line’s own ASIN when it has one, over the SKU lookup', () => {
    // The enrichment pass fills asin for some rows. Where it has, that value is
    // the line's own answer and is not second-guessed by a SKU map that may be
    // pointing an old SKU somewhere else.
    const asinBySku = buildAsinBySku([{ sku: STANLEY.sku, asin: 'B0WRONG001' }], []);
    const { byAsin } = attributeShipmentItems(
      [line({ asin: STANLEY.asin, seller_sku: STANLEY.sku, quantity_shipped: 10 })],
      asinBySku,
    );
    expect(byAsin.get(STANLEY.asin)?.shipped).toBe(10);
    expect(byAsin.has('B0WRONG001')).toBe(false);
  });

  it('sums across shipments and across SKUs of the same ASIN', () => {
    // Keyed by ASIN, not ASIN+SKU: a listing recreated under a new SKU would
    // otherwise report the original purchase as unshipped for ever.
    const asinBySku = buildAsinBySku(
      [{ sku: NASCAR.sku, asin: NASCAR.asin }, { sku: 'OLD-SKU-0001', asin: NASCAR.asin }],
      [],
    );
    const { byAsin } = attributeShipmentItems(
      [
        line({ seller_sku: NASCAR.sku, shipment_id: 'FBA1AAA', quantity_shipped: 50, quantity_received: 50 }),
        line({ seller_sku: 'OLD-SKU-0001', shipment_id: 'FBA1BBB', quantity_shipped: 42, quantity_received: 14 }),
      ],
      asinBySku,
    );
    const agg = byAsin.get(NASCAR.asin)!;
    expect(agg.shipped).toBe(92);
    expect(agg.received).toBe(64);
    expect(Array.from(agg.ids).sort()).toEqual(['FBA1AAA', 'FBA1BBB']);
  });

  it('counts one shipment once, however many lines it has for the ASIN', () => {
    // "2 shipments" when there is one would read as two separate claims.
    const asinBySku = buildAsinBySku([{ sku: STANLEY.sku, asin: STANLEY.asin }], []);
    const { byAsin } = attributeShipmentItems(
      [
        line({ seller_sku: STANLEY.sku, shipment_id: 'FBA1AAA', quantity_shipped: 5 }),
        line({ seller_sku: STANLEY.sku, shipment_id: 'FBA1AAA', quantity_shipped: 7 }),
      ],
      asinBySku,
    );
    expect(byAsin.get(STANLEY.asin)?.ids.size).toBe(1);
    expect(byAsin.get(STANLEY.asin)?.shipped).toBe(12);
  });

  it('REPORTS what it cannot attribute instead of silently dropping it', () => {
    // The whole point. A line shipped under a SKU that is in neither inventory
    // nor purchase history is still real; swallowing it is what let the page
    // present an incomplete figure as a measured one.
    const { byAsin, unmatched } = attributeShipmentItems(
      [
        line({ seller_sku: 'GONE-SKU-001', quantity_shipped: 30 }),
        line({ seller_sku: null, asin: null, quantity_shipped: 4 }),
      ],
      new Map(),
    );
    expect(byAsin.size).toBe(0);
    expect(unmatched).toEqual({ lines: 2, units: 34 });
  });

  it('treats null quantities as zero without losing the line', () => {
    const asinBySku = buildAsinBySku([{ sku: STANLEY.sku, asin: STANLEY.asin }], []);
    const { byAsin, unmatched } = attributeShipmentItems(
      [line({ seller_sku: STANLEY.sku, quantity_shipped: null, quantity_received: null })],
      asinBySku,
    );
    // A shipment line with no quantity yet is still evidence the ASIN is in a
    // shipment, so the shipment id must survive.
    expect(byAsin.get(STANLEY.asin)).toMatchObject({ shipped: 0, received: 0 });
    expect(byAsin.get(STANLEY.asin)?.ids.size).toBe(1);
    expect(unmatched.lines).toBe(0);
  });

  it('no lines at all yields no totals and no false unmatched count', () => {
    // This is the "shipment history did not load" case. It must be
    // distinguishable from "shipped nothing" by the caller, which reads
    // shipItems.length -- so this returns empty rather than inventing zeros.
    for (const empty of [[], null, undefined]) {
      const { byAsin, unmatched } = attributeShipmentItems(empty, new Map());
      expect(byAsin.size).toBe(0);
      expect(unmatched).toEqual({ lines: 0, units: 0 });
    }
  });
});

describe('the page consumes the shared rule', () => {
  it('does not keep its own copy of the matching logic', async () => {
    // A second inline copy is how the picker and the printer came to disagree
    // in the create-listing extension, and how this page came to disagree with
    // its own query -- it selected seller_sku and never used it.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const page = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'pages', 'tools', 'UnshippedPurchases.tsx'),
      'utf8',
    );
    expect(page, 'the page no longer calls the shared attribution rule')
      .toMatch(/attributeShipmentItems\(shipItems, asinBySku\)/);
    expect(page, 'the page no longer builds the sku map with the shared helper')
      .toMatch(/buildAsinBySku\(/);
    // The dropped-line bug, in any spelling.
    expect(
      page.match(/const asin = it\.asin;?\s*\r?\n\s*if \(!asin\) continue;/g) || [],
      'the page has reintroduced its own null-ASIN skip',
    ).toHaveLength(0);
    // And it must still distinguish "no data" from "zero".
    expect(page, 'the unknown-vs-zero distinction has gone')
      .toMatch(/shipmentDataLoaded/);
  });
});
