import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MARKETPLACES: Record<string, { id: string; currency: string }> = {
  CA: { id: "A2EUQ1WTGCTBG2", currency: "CAD" },
  MX: { id: "A1AM78C64UM0Y8", currency: "MXN" },
  BR: { id: "A2Q3Y263D00KWC", currency: "BRL" },
};

// AWS SigV4 signing
async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID")!;
  const awsSecretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
  const region = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

  const urlObj = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${urlObj.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-access-token;x-amz-date";
  const canonicalRequest = [method, urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join("\n");
  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, "execute-api");
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-access-token": accessToken,
    host: urlObj.host,
  };
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("LWA_CLIENT_ID") || Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") || Deno.env.get("SPAPI_LWA_CLIENT_SECRET");

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId!,
      client_secret: clientSecret!,
    }),
  });

  if (!response.ok) throw new Error(`LWA error: ${response.status}`);
  return (await response.json()).access_token;
}

function extractPrice(data: any): { price: number | null; currency: string | null } {
  if (data.offers && Array.isArray(data.offers)) {
    for (const offer of data.offers) {
      const rawAmount =
        offer.price?.amount || offer.price?.listingPrice?.amount ||
        offer.listingPrice?.amount || offer.ourPrice?.amount ||
        offer.regularPrice?.amount || offer.offerPrice?.amount ||
        offer.purchasableOffer?.price?.amount;
      const val = typeof rawAmount === "string" ? parseFloat(rawAmount) : rawAmount;
      if (val && typeof val === "number" && !isNaN(val) && val > 0) {
        return { price: val, currency: offer.price?.currency || offer.listingPrice?.currency || null };
      }
    }
  }
  if (data.summaries && Array.isArray(data.summaries)) {
    for (const s of data.summaries) {
      const val = s.price?.listingPrice?.amount || s.price?.amount;
      if (val && typeof val === "number" && val > 0) {
        return { price: val, currency: s.price?.listingPrice?.currency || s.price?.currency || null };
      }
    }
  }
  if (data.attributes?.purchasable_offer) {
    for (const po of data.attributes.purchasable_offer) {
      const val = po.our_price?.[0]?.schedule?.[0]?.value_with_tax;
      if (val && typeof val === "number" && val > 0) {
        return { price: val, currency: po.our_price?.[0]?.currency || null };
      }
    }
  }
  return { price: null, currency: null };
}

// Fetch FBA inventory summaries for a specific marketplace
async function fetchInventorySummaries(
  accessToken: string,
  marketplaceId: string,
): Promise<Map<string, { available: number; reserved: number; inbound: number }>> {
  const qtyMap = new Map<string, { available: number; reserved: number; inbound: number }>();
  let nextToken: string | undefined;

  while (true) {
    const url = new URL("https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries");
    url.searchParams.set("marketplaceIds", marketplaceId);
    url.searchParams.set("details", "true");
    url.searchParams.set("granularityType", "Marketplace");
    url.searchParams.set("granularityId", marketplaceId);
    if (nextToken) url.searchParams.set("nextToken", nextToken);

    const signedHeaders = await signRequest("GET", url.toString(), "", accessToken);
    const response = await fetch(url.toString(), { method: "GET", headers: { ...signedHeaders, "Content-Type": "application/json" } });

    if (!response.ok) {
      console.error(`[BULK_QTY] Inventory summaries error: ${response.status}`);
      break;
    }

    const data = await response.json();
    const summaries = data?.payload?.inventorySummaries || [];

    for (const item of summaries) {
      const asin = item.asin;
      if (!asin) continue;
      const existing = qtyMap.get(asin);
      const avail = item.totalFulfillableQuantity ?? item.fulfillableQuantity ?? 0;
      const reserved = item.reservedQuantity?.totalReservedQuantity ?? 0;
      const inbound = (item.inboundShippedQuantity ?? 0) + (item.inboundReceivingQuantity ?? 0);

      if (existing) {
        existing.available += avail;
        existing.reserved += reserved;
        existing.inbound += inbound;
      } else {
        qtyMap.set(asin, { available: avail, reserved, inbound });
      }
    }

    nextToken = data?.payload?.nextToken;
    if (!nextToken) break;

    await new Promise(r => setTimeout(r, 300));
  }

  return qtyMap;
}

// Batch size per invocation — larger since we pre-filter cached items
const BATCH_SIZE = 100;
// Hard wall-clock timeout to avoid WORKER_LIMIT (leave 2s buffer)
const MAX_RUNTIME_MS = 25_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, { global: { headers: { Authorization: authHeader } } });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userId = claimsData.user.id;

    const { marketplace, offset = 0, phase = "qty" } = await req.json();
    const mktConfig = MARKETPLACES[marketplace];
    if (!mktConfig) {
      return new Response(JSON.stringify({ error: "Invalid marketplace. Use CA, MX, or BR." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Get seller auth
    const { data: authRows } = await supabase
      .from("seller_authorizations")
      .select("refresh_token, seller_id, selling_partner_id, marketplace_id")
      .eq("user_id", userId);

    if (!authRows?.length) {
      return new Response(JSON.stringify({ error: "No Amazon authorization found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const authData = authRows.find(a => a.marketplace_id === mktConfig.id) ||
                     authRows.find(a => a.marketplace_id === "ATVPDKIKX0DER") ||
                     authRows[0];
    const sellerId = authData.selling_partner_id || authData.seller_id;
    if (!sellerId) {
      return new Response(JSON.stringify({ error: "No seller ID found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const accessToken = await getLwaAccessToken(authData.refresh_token);

    const startTime = Date.now();
    const timeRemaining = () => MAX_RUNTIME_MS - (Date.now() - startTime);

    // === PHASE 1: Quantity fetch (runs once) ===
    if (phase === "qty") {
      console.log(`[BULK_PRICE] Phase QTY: Fetching inventory summaries for ${marketplace}...`);
      const qtyMap = await fetchInventorySummaries(accessToken, mktConfig.id);
      console.log(`[BULK_PRICE] Got quantities for ${qtyMap.size} ASINs in ${marketplace}`);

      // Get all inventory items for qty upsert (paginated)
      const allItems: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (timeRemaining() > 3000) {
        const { data, error } = await supabase
          .from("inventory")
          .select("asin, sku")
          .eq("user_id", userId)
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data?.length) break;
        allItems.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }

      // Batch upsert assignments
      let qtyUpdated = 0;
      const now = new Date().toISOString();
      const upsertBatch: any[] = [];

      for (const [asin, qty] of qtyMap.entries()) {
        const matchingItems = allItems.filter(i => i.asin === asin);
        for (const item of matchingItems) {
          upsertBatch.push({
            user_id: userId,
            asin: item.asin,
            sku: item.sku,
            marketplace: marketplace,
            intl_available: qty.available,
            intl_reserved: qty.reserved,
            intl_inbound: qty.inbound,
            intl_qty_fetched_at: now,
          });
        }
      }

      for (const item of allItems) {
        if (!qtyMap.has(item.asin)) {
          upsertBatch.push({
            user_id: userId,
            asin: item.asin,
            sku: item.sku,
            marketplace: marketplace,
            intl_available: 0,
            intl_reserved: 0,
            intl_inbound: 0,
            intl_qty_fetched_at: now,
          });
        }
      }

      const UPSERT_BATCH = 200;
      for (let i = 0; i < upsertBatch.length; i += UPSERT_BATCH) {
        if (timeRemaining() < 2000) {
          console.warn(`[BULK_PRICE] QTY phase timeout at ${qtyUpdated} upserts`);
          break;
        }
        const chunk = upsertBatch.slice(i, i + UPSERT_BATCH);
        const { error: upsertErr } = await supabase
          .from("repricer_assignments")
          .upsert(chunk, { onConflict: "user_id,sku,marketplace" });
        if (!upsertErr) qtyUpdated += chunk.length;
        else console.error("[BULK_PRICE] Batch upsert error:", upsertErr);
      }

      return new Response(JSON.stringify({
        phase: "qty",
        qty_updated: qtyUpdated,
        qty_found: qtyMap.size,
        total_inventory: allItems.length,
        marketplace,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === PHASE 2: Price fetch (batched, called multiple times with offset) ===
    // Pre-filter: get ASINs already cached in last 24h to exclude them
    const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Get all recently cached asin|sku combos (paginated)
    const cachedKeys = new Set<string>();
    let cacheFrom = 0;
    while (true) {
      const { data: cachedItems } = await supabase
        .from("asin_my_price_cache")
        .select("asin, seller_sku")
        .eq("user_id", userId)
        .eq("marketplace_id", mktConfig.id)
        .gt("fetched_at", recentCutoff)
        .neq("seller_sku", "__NO_SKU__")
        .order("id", { ascending: true })
        .range(cacheFrom, cacheFrom + 999);
      if (!cachedItems?.length) break;
      for (const c of cachedItems) cachedKeys.add(`${c.asin}|${c.seller_sku}`);
      if (cachedItems.length < 1000) break;
      cacheFrom += 1000;
    }

    // Fetch a larger window of inventory items, skip cached ones, process up to BATCH_SIZE uncached
    const FETCH_WINDOW = 500; // fetch more rows to find enough uncached items
    const { data: windowItems, error: windowErr } = await supabase
      .from("inventory")
      .select("asin, sku")
      .eq("user_id", userId)
      .order("asin", { ascending: true })
      .range(offset, offset + FETCH_WINDOW - 1);

    if (windowErr) throw windowErr;

    if (!windowItems?.length) {
      return new Response(JSON.stringify({
        phase: "prices",
        fetched: 0, skipped: 0, errors: 0, already_cached: 0,
        batch_offset: offset, batch_size: 0, has_more: false,
        marketplace,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Split into cached (skip) and uncached (need fetch)
    const uncachedItems = windowItems.filter(i => !cachedKeys.has(`${i.asin}|${i.sku}`));
    const alreadyCached = windowItems.length - uncachedItems.length;
    const toFetch = uncachedItems.slice(0, BATCH_SIZE);

    let fetched = 0, skipped = 0, errors = 0;

    for (const item of toFetch) {
      if (timeRemaining() < 3000) {
        console.warn(`[BULK_PRICE] Approaching timeout, stopping at ${fetched} fetched`);
        break;
      }
      try {
        const encodedSku = encodeURIComponent(item.sku);
        const url = new URL(`https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodedSku}`);
        url.searchParams.set("marketplaceIds", mktConfig.id);
        url.searchParams.set("includedData", "offers,summaries");

        const signedHeaders = await signRequest("GET", url.toString(), "", accessToken);
        const response = await fetch(url.toString(), { method: "GET", headers: { ...signedHeaders, "Content-Type": "application/json" } });

        if (response.status === 404) { skipped++; await new Promise(r => setTimeout(r, 100)); continue; }
        if (response.status === 429) {
          console.warn(`[BULK_PRICE] Rate limited at ${fetched} items for ${marketplace}`);
          break;
        }
        if (!response.ok) {
          await response.text(); // consume body
          errors++;
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const data = await response.json();
        const { price, currency } = extractPrice(data);

        if (price && price > 0) {
          const { error: cacheError } = await supabase
            .from("asin_my_price_cache")
            .upsert({
              user_id: userId,
              asin: item.asin,
              marketplace_id: mktConfig.id,
              seller_sku: item.sku,
              my_price: price,
              currency: currency || mktConfig.currency,
              fetched_at: new Date().toISOString(),
              source: "listings_api_bulk",
              attempt_count: 0,
              last_error: null,
              next_retry_at: null,
            }, { onConflict: "user_id,asin,marketplace_id,seller_sku" });

          if (cacheError) { console.error(`[BULK_PRICE] Cache error for ${item.asin}:`, cacheError); errors++; }
          else { fetched++; }
        } else {
          skipped++;
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`[BULK_PRICE] Error for ${item.asin}/${item.sku}:`, err);
        errors++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const hasMore = windowItems.length === FETCH_WINDOW;

    console.log(`[BULK_PRICE] ${marketplace} batch@${offset}: fetched=${fetched}, skipped=${skipped}, errors=${errors}, cached=${alreadyCached}, hasMore=${hasMore}`);

    return new Response(JSON.stringify({
      phase: "prices",
      fetched,
      skipped,
      errors,
      already_cached: alreadyCached,
      batch_offset: offset,
      batch_size: windowItems.length,
      has_more: hasMore,
      marketplace,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    console.error("[BULK_PRICE] Error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
