/**
 * Attributing FBA shipment lines to the product they shipped.
 *
 * ── WHY THIS IS NOT INLINE IN THE PAGE ────────────────────────────────────
 *
 * Reported 2026-11-17 on /tools/unshipped-purchases: every row read
 * "Shipped 0 / Received 0" with an empty Shipments column, across 33 ASINs
 * that had plainly sold and were holding stock. The aggregation lived inside a
 * useMemo and dropped every line whose ASIN was null:
 *
 *     const asin = it.asin;
 *     if (!asin) continue;
 *
 * `fba_shipment_items.asin` IS NULLABLE and is null on write. Amazon's
 * InboundShipmentItem payload carries SellerSKU and FulfillmentNetworkSKU and
 * no ASIN at all, so sync-fba-shipments stores
 * `asin: item?.ASIN || item?.asin || null` — always null from that source. The
 * column is filled afterwards by a catalogue-enrichment pass that is skipped
 * entirely in headers-only mode and capped at 10,000 rows. `seller_sku` is
 * NOT NULL on that table and the page was already selecting it.
 *
 * This decides what the Shipped, Received and Shipments columns say, and what
 * the Missing and Value columns rest on, so it lives where a test can run it.
 *
 * ── UNMATCHED IS RETURNED, NOT SWALLOWED ──────────────────────────────────
 *
 * The silent `continue` is what made the page give a wrong answer rather than
 * an incomplete one: nothing could tell "nothing shipped" from "shipped, but
 * not matched". Lines that resolve to no ASIN come back as a count, so the UI
 * can say so.
 */

export type ShipmentLine = {
  asin: string | null;
  seller_sku: string | null;
  shipment_id: string | null;
  quantity_shipped: number | null;
  quantity_received: number | null;
};

export type AsinShipmentTotals = {
  shipped: number;
  received: number;
  /** A Set because one ASIN can appear on several lines of one shipment. */
  ids: Set<string>;
};

export type ShipmentAttribution = {
  byAsin: Map<string, AsinShipmentTotals>;
  /**
   * A count with no denominator cannot be acted on. "237 lines unmatched"
   * reads completely differently at 237 of 240 (the SKUs are from some other
   * namespace, or the shipment history is all stale) than at 237 of 5,000
   * (a handful of long-deleted SKUs, which is expected and harmless).
   *
   * `sampleSkus` exists for the same reason: the shape of the unmatched SKUs
   * says what they are. X-prefixed means the column holds FNSKUs, not
   * merchant SKUs. Recognisable old SKUs mean stale shipment history, and
   * that the current shipments were never ingested at all -- which no change
   * on this page can fix.
   */
  matched: { lines: number; asins: number };
  unmatched: { lines: number; units: number; sampleSkus: string[] };
};

/** How many example SKUs to carry back for the UI to show. */
const SAMPLE_LIMIT = 6;

/** SKUs differ only by case and padding between sources; compare normalized. */
export function skuKey(sku: string | null | undefined): string {
  return String(sku ?? '').trim().toUpperCase();
}

/**
 * sku -> asin, from the most authoritative source available.
 *
 * `inventoryRows` FIRST: that is Amazon's own mapping, for stock it has
 * actually held. `listingRows` second — the seller's own record, which also
 * covers SKUs Amazon no longer lists.
 */
export function buildAsinBySku(
  inventoryRows: { sku?: string | null; asin?: string | null }[],
  listingRows: { sku?: string | null; asin?: string | null }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const rows of [inventoryRows, listingRows]) {
    for (const r of rows ?? []) {
      const key = skuKey(r?.sku);
      if (key && r?.asin && !out.has(key)) out.set(key, r.asin);
    }
  }
  return out;
}

/**
 * Totals per ASIN, keyed by ASIN rather than ASIN+SKU on purpose: a listing is
 * frequently recreated under a new SKU, and matching the pair would report the
 * original purchase as unshipped every time that happened. ASIN is the stable
 * identity of the thing bought.
 */
export function attributeShipmentItems(
  lines: ShipmentLine[] | null | undefined,
  asinBySku: Map<string, string>,
): ShipmentAttribution {
  const byAsin = new Map<string, AsinShipmentTotals>();
  let matchedLines = 0;
  let unmatchedLines = 0;
  let unmatchedUnits = 0;
  const sampleSkus: string[] = [];

  for (const it of lines ?? []) {
    // The line's own ASIN wins when it has one; the SKU lookup is the fallback
    // for the null case, which is the common one.
    const asin = it?.asin || asinBySku.get(skuKey(it?.seller_sku)) || null;
    if (!asin) {
      unmatchedLines++;
      unmatchedUnits += Number(it?.quantity_shipped) || 0;
      const sku = skuKey(it?.seller_sku);
      if (sku && sampleSkus.length < SAMPLE_LIMIT && !sampleSkus.includes(sku)) {
        sampleSkus.push(sku);
      }
      continue;
    }
    matchedLines++;
    const agg = byAsin.get(asin) ?? { shipped: 0, received: 0, ids: new Set<string>() };
    agg.shipped += Number(it?.quantity_shipped) || 0;
    agg.received += Number(it?.quantity_received) || 0;
    if (it?.shipment_id) agg.ids.add(String(it.shipment_id));
    byAsin.set(asin, agg);
  }

  return {
    byAsin,
    matched: { lines: matchedLines, asins: byAsin.size },
    unmatched: { lines: unmatchedLines, units: unmatchedUnits, sampleSkus },
  };
}
