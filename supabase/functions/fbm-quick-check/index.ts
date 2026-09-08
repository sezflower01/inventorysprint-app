import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';
import { exchangeLwaToken } from '../_shared/lwa-token.ts';
import { getSpApiEndpoint, signRequest } from '../_shared/sp-api-sigv4.ts';
import { waitForApiToken } from "../_shared/rate-limiter.ts";
import { channelFromListingsApi } from "../_shared/fulfillment-channel.ts";

// Fast FBM onboarding check.
//
// FBM quantity normally only refreshes every 4h, because the only way to get
// it in bulk is Amazon's GET_MERCHANT_LISTINGS_ALL_DATA report — a whole-
// catalog async report that takes minutes to generate (see sync-fbm-cleanup).
// That's fine for keeping existing listings current, but it means a seller
// who just added units to a formerly-zero FBM listing in Seller Central could
// wait up to 4 hours before the repricer notices.
//
// This function closes that gap cheaply: instead of re-requesting the heavy
// report, it calls the Listings Items API per-SKU (includedData=
// fulfillmentAvailability) — but ONLY for FBM listings we already know are at
// zero. That candidate set is small (not-yet-active listings), so the whole
// check is fast and light enough to run every few minutes.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const MARKETPLACE_ID_MAP: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

const CANDIDATE_LIMIT = 50;
const PER_CALL_DELAY_MS = 300;

/**
 * Quantity AND the channel Amazon reports it under.
 *
 * The channel matters now that lane B feeds in rows whose channel we only
 * suspect. Reading a quantity off a fulfillmentAvailability entry without
 * checking its fulfillmentChannelCode would let an FBA listing's figure be
 * written into `available` as if it were merchant stock -- the same
 * one-column-two-channels confusion that zeroed real FBM quantities before.
 *
 * A null channel means Amazon did not say. That is NOT the same as FBA and is
 * returned as null so the caller can decide, rather than being folded into a
 * default here.
 */
function extractFbmQuantity(listingData: any): { qty: number | null; channel: 'FBA' | 'FBM' | null } {
  const avail = Array.isArray(listingData?.fulfillmentAvailability) ? listingData.fulfillmentAvailability : [];
  const channel = channelFromListingsApi(listingData);
  for (const entry of avail) {
    const code = String(entry?.fulfillmentChannelCode || '').toUpperCase();
    // Only a merchant-fulfilled entry carries a quantity we may treat as FBM
    // stock. An untagged entry is accepted only when nothing in the response
    // claims FBA, so a sparse-but-genuine FBM response still works.
    const usable = code === 'DEFAULT' || code === 'MERCHANT' || (!code && channel !== 'FBA');
    if (!usable) continue;
    const q = Number(entry?.quantity);
    if (Number.isFinite(q)) return { qty: q, channel };
  }
  return { qty: null, channel };
}

async function fetchLiveFbmQuantity(supabase: any, params: {
  accessToken: string;
  sellerId: string;
  sku: string;
  marketplaceId: string;
}): Promise<{ qty: number | null; channel: 'FBA' | 'FBM' | null } | null> {
  const { accessToken, sellerId, sku, marketplaceId } = params;
  const endpoint = getSpApiEndpoint(marketplaceId);
  const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
  await waitForApiToken(supabase, 'listings_api');
  const url = `${endpoint}${path}?marketplaceIds=${marketplaceId}&includedData=fulfillmentAvailability`;
  const headers = await signRequest('GET', url, '', accessToken);
  const response = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`[fbm-quick-check] Live quantity fetch failed SKU=${sku}: ${response.status} ${text.slice(0, 200)}`);
    return null;
  }
  return extractFbmQuantity(JSON.parse(text));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json().catch(() => ({}));
    const userId = body.user_id as string;
    const marketplace = (body.marketplace || 'US') as string;
    if (!userId) {
      return new Response(JSON.stringify({ ok: false, error: 'user_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const marketplaceId = MARKETPLACE_ID_MAP[marketplace] || MARKETPLACE_ID_MAP.US;

    // Candidates come from TWO lanes, because a new FBM listing does not
    // reliably arrive tagged as one.
    //
    // Lane A (unchanged): rows we already know are FBM and believe are out of
    // stock. Anything showing available>0 is already onboarded normally.
    //
    // Lane B (added 2026-09-08): rows carrying source='live_api'. When a seller
    // creates an FBM offer on an ASIN, the FBA inventory sync frequently sees
    // the SKU first and writes the row with source='live_api' and available 0 --
    // it has no notion of merchant-fulfilled quantity. Lane A then skips that
    // row forever, so the listing this function exists to rescue is precisely
    // the one it could not see. Confirmed on B0G2YNN87D / D4M-1H7-45IW.
    //
    // Lane B is deliberately narrow. Measured on the live account:
    //   source IN (fbm, live_api), status not dead      -> 3,076 rows
    //   ... ACTIVE only                                 ->   122 rows
    //   ... ACTIVE and no reserved/inbound  <- this one ->     1 row
    // Reserved or inbound units are proof Amazon is holding stock, so such a
    // SKU is FBA and can never be an FBM candidate -- excluding it costs
    // nothing and is what keeps a five-minute cron off 3,000 SP-API calls.
    // The two lanes are queried separately because PostgREST cannot express
    // this as one OR without loosening both halves.
    const [laneA, laneB] = await Promise.all([
      supabase
        .from('inventory')
        .select('id, asin, sku, available, source')
        .eq('user_id', userId)
        .eq('source', 'amazon_sync_fbm')
        .or('available.is.null,available.eq.0')
        .not('listing_status', 'in', '(DELETED,NOT_IN_CATALOG,INCOMPLETE)')
        .limit(CANDIDATE_LIMIT),
      supabase
        .from('inventory')
        .select('id, asin, sku, available, source')
        .eq('user_id', userId)
        .eq('source', 'live_api')
        .eq('listing_status', 'ACTIVE')
        .or('available.is.null,available.eq.0')
        .or('reserved.is.null,reserved.eq.0')
        .or('inbound.is.null,inbound.eq.0')
        .limit(CANDIDATE_LIMIT),
    ]);

    const candErr = laneA.error || laneB.error;
    // Lane A first so the known-FBM backlog keeps priority if the combined set
    // is trimmed; dedup by id in case a row somehow matches both.
    const seenIds = new Set<string>();
    const candidates = [...(laneA.data || []), ...(laneB.data || [])]
      .filter((r: any) => (seenIds.has(r.id) ? false : (seenIds.add(r.id), true)))
      .slice(0, CANDIDATE_LIMIT);

    if (candErr) throw candErr;
    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0, found_stock: 0, activated: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: sellerAuthRows } = await supabase
      .from('seller_authorizations')
      .select('seller_id, marketplace_id, refresh_token')
      .eq('user_id', userId);

    const sellerAuth = (sellerAuthRows || []).find((a: any) => a.marketplace_id === marketplaceId)
      || (sellerAuthRows || [])[0]
      || null;

    if (!sellerAuth?.refresh_token) {
      return new Response(JSON.stringify({ ok: true, checked: 0, found_stock: 0, activated: 0, skipped: 'no_seller_auth' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await exchangeLwaToken(sellerAuth.refresh_token, supabase, userId);

    let checked = 0;
    let retyped = 0;
    const nowStocked: Array<{ id: string; qty: number; confirmedFbm: boolean }> = [];

    for (const item of candidates) {
      checked++;
      try {
        const live = await fetchLiveFbmQuantity(supabase, {
          accessToken,
          sellerId: sellerAuth.seller_id,
          sku: item.sku,
          marketplaceId,
        });
        if (live?.channel === 'FBA') {
          // Lane B guessed wrong: this is an FBA listing that happened to read
          // zero. Leave it entirely alone -- writing a quantity here is how the
          // wrong channel's stock ends up in `available`.
          console.log(`[fbm-quick-check] SKU=${item.sku} is FBA per Listings API, skipping`);
          continue;
        }
        if (live?.qty != null && live.qty > 0) {
          nowStocked.push({
            id: item.id,
            qty: live.qty,
            // Amazon said DEFAULT/MERCHANT outright. Persist that below so the
            // row stops being a guess and lane A owns it from now on.
            confirmedFbm: live.channel === 'FBM' && item.source !== 'amazon_sync_fbm',
          });
          if (live.channel === 'FBM' && item.source !== 'amazon_sync_fbm') retyped++;
        }
      } catch (e: any) {
        console.warn(`[fbm-quick-check] SKU=${item.sku} check failed: ${e?.message || e}`);
      }
      await new Promise(r => setTimeout(r, PER_CALL_DELAY_MS));
    }

    if (nowStocked.length > 0) {
      for (const row of nowStocked) {
        const patch: Record<string, unknown> = {
          available: row.qty,
          last_inventory_sync_at: new Date().toISOString(),
        };
        // Retype the row once Amazon has confirmed the channel. This is the
        // step that stops the problem recurring: the row was created by the FBA
        // sync as 'live_api', and until it says 'amazon_sync_fbm' every later
        // caller -- lane A here, detectIsFba() in auto-assign-bulk's dedup, the
        // FBA/FBM column in the Repricer table -- has to guess at it.
        if (row.confirmedFbm) {
          patch.source = 'amazon_sync_fbm';
          // An FBM listing has no FNSKU -- that is a definition, not a
          // heuristic: an FNSKU identifies a unit in an Amazon fulfilment
          // centre. Rows arriving through the FBA path can carry one copied
          // from a sibling SKU on the same ASIN (B0G2YNN87D had X0059AXEPP on
          // BOTH its FBA and FBM SKU, and an FNSKU is per-SKU, so one of them
          // was necessarily wrong).
          //
          // This is load-bearing, not tidying. detectIsFba() reads an FNSKU as
          // proof of FBA unless an explicit FBM source with no FBA stock
          // outranks it -- which the line above now provides -- but leaving a
          // false FNSKU in place means every future reader has to rely on that
          // one precedence rule holding. Clearing it makes the row honest at
          // rest. Only ever done when Amazon itself returned DEFAULT/MERCHANT.
          patch.fnsku = null;
        }
        await supabase
          .from('inventory')
          .update(patch)
          .eq('id', row.id);
      }

      // Reuse the same onboarding path everything else uses — creates/enables
      // the repricer assignment, computes min/max, raises price to floor.
      let activated = 0;
      try {
        const assignResp = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify({ user_id: userId, marketplace }),
        });
        if (assignResp.ok) {
          const assignData = await assignResp.json();
          activated = Number(assignData.created || 0) + Number(assignData.reenabled || 0);
        } else {
          console.warn(`[fbm-quick-check] auto-assign-bulk returned ${assignResp.status}: ${await assignResp.text()}`);
        }
      } catch (e: any) {
        console.warn('[fbm-quick-check] auto-assign-bulk call failed:', e?.message || e);
      }

      return new Response(JSON.stringify({ ok: true, checked, found_stock: nowStocked.length, retyped, activated }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, checked, found_stock: 0, retyped, activated: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[fbm-quick-check] Error:', e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
