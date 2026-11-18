/**
 * PROBE ONLY. Measures the bulk FBA inbound items endpoint. WRITES NOTHING.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Every item fetch in this repo uses the PER-SHIPMENT path,
 * `GET /fba/inbound/v0/shipments/{shipmentId}/items` -- one SP-API call per
 * shipment whether that shipment holds one line or two hundred. Measured
 * 2026-11-18 14:13Z on the live account: 6 fetches in 77s and 4 in 98s, i.e.
 * 12-25s each, all returning zero items. At that rate the ~2,219 shipments on
 * record cannot be walked inside the platform's 150s request kill, and
 * bounding the loop (which shipped in 01ce347) only makes it fail politely.
 *
 * Amazon has a bulk alternative that this repo has never called. Verified
 * 2026-11-18 against fulfillmentInboundV0.json in amzn/selling-partner-api-models
 * (downloaded and parsed, not recalled):
 *
 *     GET /fba/inbound/v0/shipmentItems
 *       QueryType          REQUIRED  enum DATE_RANGE | NEXT_TOKEN
 *       MarketplaceId      REQUIRED
 *       LastUpdatedAfter   optional  date-time
 *       LastUpdatedBefore  optional  date-time
 *       NextToken          optional
 *
 * Response is `payload.ItemData[]` + `payload.NextToken` -- the IDENTICAL
 * shape fetchV0ShipmentItems already parses -- and each InboundShipmentItem
 * carries its own `ShipmentId`, so lines spanning many shipments stay
 * attributable. The documented rate limit is the same as the per-shipment
 * call (2 rps, burst 30), so this is strictly cheaper for identical quota.
 *
 * ── WHAT THE SPEC DOES NOT SAY, AND THIS MEASURES ─────────────────────────
 *
 *   1. PAGE SIZE. The spec states none, so the number of pages for a given
 *      window cannot be predicted. Guessing it would just be the last three
 *      wrong guesses again.
 *   2. WHETHER v0 RETURNS "SEND TO AMAZON" SHIPMENTS. The docs say nothing
 *      either way. This is the open question behind the missing October: the
 *      only v2024 discovery path in sync-fba-shipments had never once
 *      executed (its arguments were shifted by one, so it threw RangeError on
 *      its first line and was logged as "v2024 discovery failed").
 *   3. WHETHER THE LINES ARE NON-EMPTY. The per-shipment call is returning
 *      zero items; if the bulk call returns real lines for the same period,
 *      the per-shipment path is not merely slow, it is also wrong.
 *
 * It deliberately performs NO writes and NO upserts, so it can be run against
 * production without touching a row. Wire the real fetcher only after reading
 * what this reports.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getLWAAccessToken, getSpApiEndpoint, signRequest } from "../_shared/sp-api-sigv4.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

/** Never exceed this; the platform kills the request at 150s. */
const HARD_CEILING_MS = 120_000;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const T0 = Date.now();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    // Auth mirrors sync-fba-shipments: a user JWT, or internal-secret +
    // body.user_id. Same rule, because this reads the same seller credentials.
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const providedSecret = req.headers.get('x-internal-secret');
    let userId: string | null = null;

    if (expectedSecret && providedSecret && providedSecret === expectedSecret) {
      userId = typeof body?.user_id === 'string' ? body.user_id : null;
      if (!userId) return json({ error: 'user_id required when using internal-secret auth' }, 400);
    } else {
      const authHeader = req.headers.get('Authorization') ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) return json({ error: 'Unauthorized' }, 401);
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);
      userId = userData.user.id;
    }

    const lookbackDays = Number.isFinite(Number(body?.lookbackDays))
      ? Math.max(1, Math.min(540, Math.floor(Number(body.lookbackDays))))
      : 60;
    const maxPages = Number.isFinite(Number(body?.maxPages))
      ? Math.max(1, Math.min(20, Math.floor(Number(body.maxPages))))
      : 4;

    // NOT maybeSingle(): a user holds one row PER MARKETPLACE, and
    // maybeSingle() errors outright on more than one. Mirrors the selection in
    // sync-fba-shipments -- prefer US, then any NA marketplace -- because FBA
    // inbound shipments live on the NA endpoint.
    const { data: authRows, error: authErr } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id')
      .eq('user_id', userId);

    if (authErr || !authRows || authRows.length === 0) {
      return json({ error: 'no seller authorization for this user', detail: authErr?.message ?? null }, 400);
    }

    const NA_MARKETPLACES = ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'];
    const auth =
      authRows.find((r: any) => r.marketplace_id === 'ATVPDKIKX0DER') ||
      authRows.find((r: any) => NA_MARKETPLACES.includes(r.marketplace_id)) ||
      authRows[0];

    if (!auth?.refresh_token) {
      return json({ error: 'seller authorization row carries no refresh_token' }, 400);
    }

    const marketplaceId = (typeof body?.marketplaceId === 'string' && body.marketplaceId)
      || auth.marketplace_id
      || 'ATVPDKIKX0DER';
    const endpoint = getSpApiEndpoint(marketplaceId);
    const accessToken = await getLWAAccessToken(auth.refresh_token);

    const after = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
    const before = new Date().toISOString();

    // ---- page through the bulk endpoint, measuring each call ----------------
    interface PageStat {
      page: number;
      ms: number;
      status: number;
      lines: number;
      bytes: number;
      distinct_shipments: number;
      has_next: boolean;
      error?: string;
    }

    const pages: PageStat[] = [];
    const allShipmentIds = new Set<string>();
    const skus = new Set<string>();
    let totalLines = 0;
    let linesWithQtyShipped = 0;
    let linesWithQtyReceived = 0;
    let nextToken: string | null = null;
    let sample: unknown[] = [];
    let fatal: string | null = null;

    for (let page = 1; page <= maxPages; page++) {
      if (Date.now() - T0 > HARD_CEILING_MS) {
        fatal = `stopped at local ceiling after ${Date.now() - T0}ms`;
        break;
      }

      const params = new URLSearchParams({ MarketplaceId: marketplaceId });
      if (nextToken) {
        params.set('QueryType', 'NEXT_TOKEN');
        params.set('NextToken', nextToken);
      } else {
        params.set('QueryType', 'DATE_RANGE');
        params.set('LastUpdatedAfter', after);
        params.set('LastUpdatedBefore', before);
      }

      const url = `${endpoint}/fba/inbound/v0/shipmentItems?${params.toString()}`;
      const started = Date.now();

      // No shared rate gate on purpose: this is a one-off probe of at most 20
      // calls against a 2 rps limit, and borrowing the 'inbound_api' bucket
      // would make the latency numbers measure our own queue rather than
      // Amazon's. A deliberate 600ms spacing keeps it under the documented
      // limit without that.
      const headers = await signRequest('GET', url, '', accessToken);
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': headers['Authorization'],
          'x-amz-date': headers['x-amz-date'],
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      });
      const text = await resp.text();
      const ms = Date.now() - started;

      if (!resp.ok) {
        pages.push({
          page, ms, status: resp.status, lines: 0, bytes: text.length,
          distinct_shipments: 0, has_next: false,
          error: text.slice(0, 300),
        });
        fatal = `HTTP ${resp.status} on page ${page}`;
        break;
      }

      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch { /* reported below */ }
      const items = Array.isArray(parsed?.payload?.ItemData) ? parsed.payload.ItemData : [];
      const pageShipments = new Set<string>();

      for (const it of items) {
        totalLines++;
        const sid = it?.ShipmentId ? String(it.ShipmentId) : null;
        if (sid) { allShipmentIds.add(sid); pageShipments.add(sid); }
        if (it?.SellerSKU) skus.add(String(it.SellerSKU));
        // Quantity is an object in this model; count presence, not value.
        if (it?.QuantityShipped !== undefined && it?.QuantityShipped !== null) linesWithQtyShipped++;
        if (it?.QuantityReceived !== undefined && it?.QuantityReceived !== null) linesWithQtyReceived++;
      }

      nextToken = typeof parsed?.payload?.NextToken === 'string' && parsed.payload.NextToken.length > 0
        ? parsed.payload.NextToken
        : null;

      pages.push({
        page, ms, status: resp.status, lines: items.length, bytes: text.length,
        distinct_shipments: pageShipments.size, has_next: Boolean(nextToken),
      });

      // Keep two redacted lines so the shape can be read without dumping the
      // catalogue into a response.
      if (sample.length === 0 && items.length > 0) {
        sample = items.slice(0, 2).map((it: any) => ({
          ShipmentId: it?.ShipmentId ?? null,
          SellerSKU: it?.SellerSKU ? `${String(it.SellerSKU).slice(0, 4)}…` : null,
          FulfillmentNetworkSKU: it?.FulfillmentNetworkSKU ? `${String(it.FulfillmentNetworkSKU).slice(0, 4)}…` : null,
          QuantityShipped: it?.QuantityShipped ?? null,
          QuantityReceived: it?.QuantityReceived ?? null,
          keys_present: Object.keys(it ?? {}),
        }));
      }

      if (!nextToken) break;
      await new Promise((r) => setTimeout(r, 600));
    }

    // ---- how much of this is NEW to us? -----------------------------------
    // The question behind the missing October: does the bulk call surface
    // shipments our own table has never seen (which would include Send to
    // Amazon shipments, if v0 covers them at all)?
    const ids = Array.from(allShipmentIds);
    const knownIds = new Set<string>();
    for (let i = 0; i < ids.length; i += 150) {
      const { data } = await supabase
        .from('fba_shipments')
        .select('shipment_id')
        .eq('user_id', userId)
        .in('shipment_id', ids.slice(i, i + 150));
      for (const r of data ?? []) if (r?.shipment_id) knownIds.add(String(r.shipment_id));
    }

    const withItemsAlready = new Set<string>();
    for (let i = 0; i < ids.length; i += 150) {
      const { data } = await supabase
        .from('fba_shipment_items')
        .select('shipment_id')
        .eq('user_id', userId)
        .in('shipment_id', ids.slice(i, i + 150));
      for (const r of data ?? []) if (r?.shipment_id) withItemsAlready.add(String(r.shipment_id));
    }

    const pageSizes = pages.filter((p) => p.status === 200).map((p) => p.lines);
    const completedPages = pages.filter((p) => p.status === 200);

    return json({
      probe: 'bulk-shipment-items',
      wrote_nothing: true,
      window: { lookbackDays, after, before, marketplaceId, endpoint },

      verdict: {
        endpoint_works: completedPages.length > 0 && !fatal,
        // The headline: does the bulk call return lines where the
        // per-shipment call was returning none?
        returned_lines: totalLines,
        page_size_observed: pageSizes.length > 0 ? Math.max(...pageSizes) : 0,
        pages_fetched: pages.length,
        more_pages_remain: Boolean(nextToken),
        median_page_ms: completedPages.length > 0
          ? completedPages.map((p) => p.ms).sort((a, b) => a - b)[Math.floor(completedPages.length / 2)]
          : null,
        fatal,
      },

      coverage: {
        distinct_shipments_seen: allShipmentIds.size,
        distinct_skus_seen: skus.size,
        lines_with_quantity_shipped: linesWithQtyShipped,
        lines_with_quantity_received: linesWithQtyReceived,
        // > 0 here means the bulk call knows about shipments we do not. That
        // is the Send-to-Amazon question answered empirically.
        shipments_we_have_never_seen: ids.filter((id) => !knownIds.has(id)).length,
        shipments_we_have_but_without_items: ids.filter(
          (id) => knownIds.has(id) && !withItemsAlready.has(id),
        ).length,
        shipments_already_complete: ids.filter((id) => withItemsAlready.has(id)).length,
      },

      // Per-page detail, so page size is read rather than assumed.
      pages,
      sample_lines: sample,
      elapsed_ms: Date.now() - T0,
    });
  } catch (e) {
    return json(
      { error: (e as Error)?.message ?? String(e), elapsed_ms: Date.now() - T0, wrote_nothing: true },
      500,
    );
  }
});
