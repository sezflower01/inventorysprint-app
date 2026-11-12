// Returns package + item dimensions and weight for an ASIN.
// Source: SP-API Catalog Items (dimensions) → Keepa product fallback.
// Cached in public.asin_dimensions_cache (per asin+marketplace).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import {
  acquireKeepaTokensOnly, reportKeepaTokensLeft, recordKeepa429,
  KEEPA_COST, KEEPA_RESERVE,
} from "../_shared/keepa-rate-gate.ts";
import { mayUseOperatorCredentials } from "../_shared/operator-credential-guard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Marketplace → SP-API marketplaceId + Keepa domain id
const MKT: Record<string, { mpId: string; keepa: number; region: 'NA' | 'EU' | 'FE' }> = {
  US: { mpId: 'ATVPDKIKX0DER', keepa: 1, region: 'NA' },
  CA: { mpId: 'A2EUQ1WTGCTBG2', keepa: 6, region: 'NA' },
  MX: { mpId: 'A1AM78C64UM0Y8', keepa: 11, region: 'NA' },
  BR: { mpId: 'A2Q3Y263D00KWC', keepa: 12, region: 'NA' },
  UK: { mpId: 'A1F83G8C2ARO7P', keepa: 2, region: 'EU' },
  DE: { mpId: 'A1PA6795UKMFR9', keepa: 3, region: 'EU' },
  FR: { mpId: 'A13V1IB3VIYZZH', keepa: 4, region: 'EU' },
  IT: { mpId: 'APJ6JRA9NG5V4', keepa: 8, region: 'EU' },
  ES: { mpId: 'A1RKKUPIHCS9HS', keepa: 9, region: 'EU' },
  IN: { mpId: 'A21TJRUUN4KGV', keepa: 10, region: 'EU' },
  JP: { mpId: 'A1VC38T7YXB528', keepa: 5, region: 'FE' },
};

// ── SP-API helpers (SigV4) ─────────────────────────────────────────
function hmac(key: string | Uint8Array, data: string): Uint8Array {
  const h = createHmac('sha256', key as any); h.update(data);
  return new Uint8Array(h.digest());
}
function signingKey(k: string, date: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${k}`, date), region), service), 'aws4_request');
}
async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s) as any);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const tokCache: Record<string, { tok: string; exp: number }> = {};
async function lwa(region: 'NA' | 'EU' | 'FE', refreshOverride?: string | null): Promise<string> {
  const cid = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const sec = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  const rt = refreshOverride
    || (region === 'EU' ? Deno.env.get('SPAPI_REFRESH_TOKEN_EU')
      : region === 'FE' ? Deno.env.get('SPAPI_REFRESH_TOKEN_FE')
      : Deno.env.get('SPAPI_REFRESH_TOKEN'));
  if (!cid || !sec || !rt) throw new Error(`Missing LWA creds for ${region}`);
  const ck = `${region}:${rt.slice(0, 10)}`;
  if (tokCache[ck] && tokCache[ck].exp > Date.now()) return tokCache[ck].tok;
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: cid, client_secret: sec }),
  });
  if (!r.ok) throw new Error(`LWA ${region} ${r.status}`);
  const j = await r.json();
  tokCache[ck] = { tok: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return j.access_token;
}

async function spGet(path: string, query: Record<string, string>, accessToken: string, region: 'NA' | 'EU' | 'FE') {
  const ak = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const sk = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = region === 'EU' ? 'eu-west-1' : region === 'FE' ? 'us-west-2' : 'us-east-1';
  const host = region === 'EU' ? 'sellingpartnerapi-eu.amazon.com'
    : region === 'FE' ? 'sellingpartnerapi-fe.amazon.com'
    : 'sellingpartnerapi-na.amazon.com';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const qs = new URLSearchParams(query).toString();
  const canonHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const canonReq = `GET\n${path}\n${qs}\n${canonHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${awsRegion}/execute-api/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonReq)}`;
  const sig = createHmac('sha256', signingKey(sk, date, awsRegion, 'execute-api') as any);
  sig.update(toSign);
  const auth = `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig.digest('hex')}`;
  const r = await fetch(`https://${host}${path}?${qs}`, {
    headers: { host, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken, Authorization: auth },
  });
  if (!r.ok) throw new Error(`SP-API ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── Extract dims from SP-API catalog response ──────────────────────
function pickSpDims(catalog: any) {
  // Catalog Items 2022-04-01 with includedData=dimensions returns:
  //   item.dimensions = [{ marketplaceId, item: { length:{value,unit}, width, height, weight }, package: {...} }]
  const dimsArr = catalog?.dimensions;
  if (!Array.isArray(dimsArr) || dimsArr.length === 0) return null;
  const first = dimsArr[0] || {};
  const pkg = first.package || {};
  const itm = first.item || {};
  const v = (o: any) => (o && typeof o.value === 'number') ? o.value : null;
  const u = (o: any) => (o && typeof o.unit === 'string') ? o.unit : null;
  const out = {
    package_length: v(pkg.length), package_width: v(pkg.width), package_height: v(pkg.height),
    package_dim_unit: u(pkg.length) || u(pkg.width) || u(pkg.height),
    package_weight: v(pkg.weight), package_weight_unit: u(pkg.weight),
    item_length: v(itm.length), item_width: v(itm.width), item_height: v(itm.height),
    item_dim_unit: u(itm.length) || u(itm.width) || u(itm.height),
    item_weight: v(itm.weight), item_weight_unit: u(itm.weight),
  };
  const any = Object.values(out).some(x => x != null && x !== '');
  return any ? out : null;
}

// ── Keepa fallback ─────────────────────────────────────────────────
// Keepa product API exposes packageHeight/Length/Width (mm) and packageWeight (g),
// plus itemHeight/Length/Width and itemWeight at the product root.
// Gated 2026-08-19 with a TOKEN-ONLY claim. This function spent Keepa tokens
// with no claim, no tokensLeft reporting and no 429 recording -- one of the
// three blind spenders that let the account reach Keepa's own tokensLeft of -9
// while local accounting still read 38.
//
// Token-only rather than the two-layer gate on purpose: claiming a call-rate
// slot here (4/min, global) is what made a single analyzer page view starve
// itself on 2026-08-18. Metering the spend does not require rationing calls.
//
// Refusal returns null, which is already the "no dimensions" path the caller
// handles -- the result is a missing field, never a broken response.
async function keepaDims(supabase: any, asin: string, domainId: number) {
  const key = Deno.env.get('KEEPA_API_KEY');
  if (!key) return null;

  const slot = await acquireKeepaTokensOnly(supabase, {
    estimatedTokens: KEEPA_COST.productPerAsin,
    minReserve: KEEPA_RESERVE.interactive,
  });
  if (!slot.ok) {
    console.warn(`[asin-dimensions] Keepa budget busy (${slot.blockedBy}), skipping dimensions fallback`);
    return null;
  }

  const url = `https://api.keepa.com/product?key=${key}&domain=${domainId}&asin=${asin}&stats=0`;
  const r = await fetch(url);
  if (!r.ok) {
    if (r.status === 429) await recordKeepa429(supabase, undefined, 'asin-dimensions');
    return null;
  }
  const j = await r.json();
  // Reconcile before the in-body error check: a failed 200 still moved the
  // balance, and not reporting it is what makes local accounting drift high.
  await reportKeepaTokensLeft(supabase, j?.tokensLeft, j?.refillRate);
  if (j?.error) return null;
  const p = j?.products?.[0];
  if (!p) return null;
  // Keepa uses -1 / 0 for "unknown". Convert mm→cm and g→g (kept in g but flagged).
  const mm = (n: any) => (typeof n === 'number' && n > 0) ? +(n / 10).toFixed(2) : null; // cm
  const g = (n: any) => (typeof n === 'number' && n > 0) ? n : null; // grams
  const out = {
    package_length: mm(p.packageLength), package_width: mm(p.packageWidth), package_height: mm(p.packageHeight),
    package_dim_unit: 'centimeters',
    package_weight: g(p.packageWeight), package_weight_unit: 'grams',
    item_length: mm(p.itemLength), item_width: mm(p.itemWidth), item_height: mm(p.itemHeight),
    item_dim_unit: 'centimeters',
    item_weight: g(p.itemWeight), item_weight_unit: 'grams',
  };
  const any = Object.values(out).some(x => x != null && typeof x === 'number');
  return any ? out : null;
}

const CACHE_TTL_DAYS = 30;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = req.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: claims } = await userClient.auth.getClaims(auth.slice(7));
    if (!claims?.claims?.sub) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const asin = String(body.asin || '').trim().toUpperCase();
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const force = !!body.force;
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: 'Invalid asin' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const mkt = MKT[marketplace] || MKT.US;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // 1) cache lookup
    if (!force) {
      const { data: cached } = await admin
        .from('asin_dimensions_cache')
        .select('*')
        .eq('asin', asin).eq('marketplace', marketplace).maybeSingle();
      if (cached) {
        const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
        if (ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
          return new Response(JSON.stringify({ ...cached, cached: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // 2) SP-API catalog (per-user refresh token if available)
    let dims: any = null;
    let source: 'spapi' | 'keepa' | null = null;
    try {
      const { data: sa } = await admin
        .from('seller_authorizations')
        .select('refresh_token')
        .eq('user_id', claims.claims.sub)
        .eq('marketplace_id', mkt.mpId)
        .eq('is_active', true)
        .maybeSingle();
      // lwa() falls back to the operator's SPAPI_REFRESH_TOKEN* when handed
      // null, so a user with no connection would have dimensions fetched on
      // the operator's Amazon account and quota.
      //
      // This one SKIPS the SP-API attempt rather than refusing the request,
      // which the gating and fee functions do. Dimensions are a property of
      // the product, not of a seller account, so there is no wrong answer to
      // give here -- the only harm is spending the operator's SP-API quota,
      // which competes with the repricer. Leaving `dims` null falls through to
      // the Keepa path below, so an unconnected user still gets dimensions.
      let mayUseOperatorSpApi = true;
      if (!sa?.refresh_token) {
        const may = await mayUseOperatorCredentials(admin, {
          userId: String(claims.claims.sub),
          internal: false, // no x-internal-secret path in this function
          fn: 'asin-dimensions',
        });
        mayUseOperatorSpApi = may.allowed;
      }
      if (!mayUseOperatorSpApi) {
        throw new Error('SKIP_SPAPI_NOT_CONNECTED'); // caught below; Keepa still runs
      }
      const tok = await lwa(mkt.region, sa?.refresh_token || null);
      const cat = await spGet(
        `/catalog/2022-04-01/items/${asin}`,
        { marketplaceIds: mkt.mpId, includedData: 'dimensions' },
        tok, mkt.region,
      );
      dims = pickSpDims(cat);
      if (dims) source = 'spapi';
    } catch (e) {
      console.warn('[asin-dimensions] SP-API failed, falling back to Keepa:', (e as Error).message);
    }

    // 3) Keepa fallback
    if (!dims) {
      try {
        dims = await keepaDims(admin, asin, mkt.keepa);
        if (dims) source = 'keepa';
      } catch (e) {
        console.warn('[asin-dimensions] Keepa failed:', (e as Error).message);
      }
    }

    if (!dims) {
      return new Response(JSON.stringify({ asin, marketplace, source: null, found: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const row = { asin, marketplace, source, fetched_at: new Date().toISOString(), ...dims };
    await admin.from('asin_dimensions_cache').upsert(row, { onConflict: 'asin,marketplace' });

    return new Response(JSON.stringify({ ...row, cached: false, found: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[asin-dimensions] error', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
