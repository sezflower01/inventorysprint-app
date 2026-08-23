// Customer Intelligence — backfill buyer info + emit Health issues
// Iterates sales_orders missing buyer_email, calls SP-API getOrder for each,
// updates buyer fields, and inserts business_health_issues for review-level profiles.
//
// Idempotent. Safe to run repeatedly. Limits per invocation to keep under SP-API budget.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const enc = new TextEncoder();
async function sha256(input: string) {
  return await crypto.subtle.digest('SHA-256', enc.encode(input));
}
function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key: ArrayBuffer, msg: string) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
}
async function getSignatureKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = await hmac(enc.encode('AWS4' + secret).buffer, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';
  const urlObj = new URL(url);
  const host = urlObj.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { Authorization: authHeader, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken, host };
}

async function getLWAAccessToken(refreshToken: string, overrideClientId?: string, overrideClientSecret?: string): Promise<string> {
  const clientId = overrideClientId || Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_CLIENT_ID')!;
  const clientSecret = overrideClientSecret || Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_CLIENT_SECRET')!;
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error('LWA token error: ' + (await res.text()));
  return (await res.json()).access_token;
}

const SPAPI_HOSTS: Record<string, string> = {
  US: 'https://sellingpartnerapi-na.amazon.com',
  CA: 'https://sellingpartnerapi-na.amazon.com',
  MX: 'https://sellingpartnerapi-na.amazon.com',
  BR: 'https://sellingpartnerapi-na.amazon.com',
  UK: 'https://sellingpartnerapi-eu.amazon.com',
  DE: 'https://sellingpartnerapi-eu.amazon.com',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const body = await req.json().catch(() => ({}));
    const userId: string | undefined = body?.userId;
    const limit: number = Math.min(Math.max(parseInt(String(body?.limit || '150'), 10), 1), 500);
    const emitHealthIssues: boolean = body?.emitHealthIssues !== false;

    // Resolve one or all users
    let userIds: string[] = [];
    if (userId) {
      userIds = [userId];
    } else {
      const { data } = await supabase.from('user_spapi_credentials').select('user_id').limit(500);
      userIds = Array.from(new Set((data || []).map((r: any) => r.user_id))).filter(Boolean);
    }

    const perUserStats: any[] = [];

    for (const uid of userIds) {
      const stats = { userId: uid, resolved: 0, apiCalls: 0, skipped: 0, healthIssues: 0, errors: [] as string[] };

      // Get SP-API creds via SECURITY DEFINER decrypt RPC (matches sync-sales-orders pattern)
      let refreshToken: string | null = Deno.env.get('SPAPI_REFRESH_TOKEN') || null;
      let clientId: string | null = Deno.env.get('LWA_CLIENT_ID') || null;
      let clientSecret: string | null = Deno.env.get('LWA_CLIENT_SECRET') || null;
      try {
        const { data: credRows } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: uid });
        const cred = (credRows as any[])?.[0];
        if (cred?.refresh_token) refreshToken = cred.refresh_token;
        if (cred?.lwa_client_id) clientId = cred.lwa_client_id;
        if (cred?.lwa_client_secret) clientSecret = cred.lwa_client_secret;
      } catch (_e) { /* fall through */ }

      if (!refreshToken) {
        stats.errors.push('no_spapi_credentials');
        perUserStats.push(stats);
        continue;
      }

      let accessToken = '';
      try {
        accessToken = await getLWAAccessToken(refreshToken, clientId || undefined, clientSecret || undefined);
      } catch (e: any) {
        stats.errors.push('lwa_failed:' + e.message);
        perUserStats.push(stats);
        continue;
      }

      // Base order IDs missing buyer_email (strip -REFUND suffix, distinct)
      const { data: pending } = await supabase
        .from('sales_orders')
        .select('order_id, marketplace')
        .eq('user_id', uid)
        .is('buyer_email', null)
        .not('order_id', 'like', '%-REFUND%')
        .gte('order_date', new Date(Date.now() - 730 * 86400 * 1000).toISOString())
        .order('order_date', { ascending: false })
        .limit(limit * 2);

      const uniqueBaseIds = new Set<string>();
      const marketplaceByOrder = new Map<string, string>();
      for (const r of pending || []) {
        const base = String(r.order_id || '').split('-REFUND')[0];
        if (!base || base.length < 10) continue;
        if (uniqueBaseIds.has(base)) continue;
        uniqueBaseIds.add(base);
        marketplaceByOrder.set(base, r.marketplace || 'US');
        if (uniqueBaseIds.size >= limit) break;
      }

      // Helper: request a Restricted Data Token (RDT) for buyerInfo scope on a given order
      // Returns null if the seller's SP-API app lacks PII role approval (403) or any error.
      const rdtCache = new Map<string, string>();
      async function getRdtForOrder(orderId: string): Promise<string | null> {
        const cached = rdtCache.get(orderId);
        if (cached) return cached;
        try {
          const tokenUrl = `${SPAPI_HOSTS.US}/tokens/2021-03-01/restrictedDataToken`;
          const bodyObj = {
            restrictedResources: [
              {
                method: 'GET',
                path: `/orders/v0/orders/${orderId}`,
                dataElements: ['buyerInfo', 'shippingAddress'],
              },
            ],
          };
          const bodyStr = JSON.stringify(bodyObj);
          // NOTE: tokens API uses the NA host but is region-neutral; path is stable
          const hdrs = await signRequest('POST', tokenUrl, bodyStr, accessToken);
          const res = await fetch(tokenUrl, {
            method: 'POST',
            headers: { ...hdrs, 'Content-Type': 'application/json' },
            body: bodyStr,
          });
          if (!res.ok) return null;
          const j = await res.json();
          const rdt = j?.restrictedDataToken || null;
          if (rdt) rdtCache.set(orderId, rdt);
          return rdt;
        } catch {
          return null;
        }
      }

      let rdtUnavailable = false; // once 403'd we stop asking

      for (const baseOrderId of uniqueBaseIds) {
        const mp = marketplaceByOrder.get(baseOrderId) || 'US';
        const host = SPAPI_HOSTS[mp] || SPAPI_HOSTS.US;
        const url = `${host}/orders/v0/orders/${encodeURIComponent(baseOrderId)}`;
        try {
          // Path A: try RDT-scoped fetch first (returns real BuyerInfo + shippingAddress)
          let usedRdt = false;
          let res: Response | null = null;
          if (!rdtUnavailable) {
            const rdt = await getRdtForOrder(baseOrderId);
            if (rdt) {
              const rdtHeaders = await signRequest('GET', url, '', rdt);
              res = await fetch(url, { method: 'GET', headers: rdtHeaders });
              stats.apiCalls++;
              usedRdt = true;
              if (res.status === 403) {
                // App lacks PII role approval — stop trying RDT for this run
                rdtUnavailable = true;
                res = null;
              }
            } else {
              rdtUnavailable = true;
            }
          }

          // Fallback: unscoped call (BuyerInfo will be empty but call still succeeds)
          if (!res) {
            const headers = await signRequest('GET', url, '', accessToken);
            res = await fetch(url, { method: 'GET', headers });
            stats.apiCalls++;
          }

          if (res.status === 429) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (!res.ok) {
            stats.skipped++;
            continue;
          }
          const j = await res.json();
          const payload = j?.payload || {};
          const bi = payload?.BuyerInfo || {};
          const sa = payload?.ShippingAddress || {};
          const buyer_email: string | null = bi?.BuyerEmail || null;
          const buyer_name: string | null = bi?.BuyerName || null;
          const buyer_id: string | null = bi?.BuyerId || null;

          // Ship-to hash — works even without PII (StateOrRegion + PostalCode + City)
          let ship_to_hash: string | null = null;
          if (sa && (sa.PostalCode || sa.City)) {
            const raw = [sa.City, sa.StateOrRegion, sa.PostalCode, sa.CountryCode]
              .filter(Boolean)
              .map((v: string) => String(v).toLowerCase().trim())
              .join('|');
            if (raw) {
              const hashBuf = await sha256(raw);
              ship_to_hash = toHex(hashBuf).slice(0, 32);
            }
          }

          const patch: Record<string, string> = {};
          if (buyer_email) patch.buyer_email = buyer_email;
          if (buyer_name) patch.buyer_name = buyer_name;
          if (buyer_id) patch.buyer_id = buyer_id;
          if (ship_to_hash) patch.ship_to_hash = ship_to_hash;

          if (Object.keys(patch).length === 0) {
            // Amazon returned no PII and no address (typical without RDT approval).
            // Path B (detect-abuse-patterns) handles this case.
            stats.skipped++;
          } else {
            // ONE PREFIX MATCH, NOT `.or(eq, like)`.
            //
            // Amazon order ids are a fixed 3-7-7 format, so nothing can begin
            // with a complete order id except that order and its own refund
            // rows. Verified 2026-08-23 against live data: refunds are
            // `<order>-REFUND`, `-REFUND-1`, `-REFUND-2` and so on -- 115 rows
            // carried a numeric suffix, which is why the trailing % is load
            // bearing and an `.in([base, base + '-REFUND'])` would have
            // silently missed them.
            //
            // The OR was not merely redundant, it was ruinous. PostgREST
            // parameterises the pattern, and an OR branch the planner cannot
            // index drags the whole predicate down with it -- so this ran as a
            // SEQUENTIAL SCAN of every one of the user's 71,983 sales_orders
            // rows, ONCE PER ORDER, inside the */15 customer-profiles cron
            // (jobid 100). Measured with literal values, where the planner has
            // every advantage: 3,341ms and 9,138 buffers to find one row. That
            // is a direct source of "canceling statement due to statement
            // timeout", and it holds row locks while it scans.
            //
            // A prefix LIKE still cannot use an ordinary b-tree under this
            // database's collation, so the fix is only half here: see
            // 20260823000000_sales_orders_order_prefix_index.sql, which adds a
            // text_pattern_ops index. With it the planner rewrites the LIKE
            // into a range scan (order_id ~>=~ base AND order_id ~<~ base+1):
            //
            //   rows discarded   71,982 -> 0
            //   buffers          9,138  -> 4
            //   execution        3,341ms -> 3.3ms
            const { error: upErr } = await supabase
              .from('sales_orders')
              .update(patch)
              .eq('user_id', uid)
              .like('order_id', `${baseOrderId}%`);
            if (upErr) {
              stats.errors.push(`update_failed:${baseOrderId}:${upErr.message}`);
              continue;
            }
            stats.resolved++;
            if (usedRdt) (stats as any).rdtResolved = ((stats as any).rdtResolved || 0) + 1;
          }
        } catch (e: any) {
          stats.errors.push(`fetch_failed:${baseOrderId}:${e.message}`);
        }
        // small pause to avoid throttling
        await new Promise((r) => setTimeout(r, 220));
      }

      // Path B fallback — always run pattern detector so Customer Intelligence
      // never depends solely on PII approval.
      try {
        const projectRef = (Deno.env.get('SUPABASE_URL') || '').match(/https:\/\/([^.]+)/)?.[1];
        if (projectRef) {
          await fetch(`https://${projectRef}.supabase.co/functions/v1/detect-abuse-patterns`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            },
            body: JSON.stringify({ userId: uid, windowDays: 90 }),
          }).catch(() => {});
        }
      } catch (_e) { /* non-fatal */ }

      // Emit Business Health issues for review-level profiles
      if (emitHealthIssues) {
        const { data: reviewProfiles } = await supabase
          .from('customer_profiles')
          .select('customer_key, buyer_email, buyer_name, order_ids, distinct_asins, orders_count, refund_amount_usd, refund_orders_count, replacement_orders_count, last_seen_at')
          .eq('user_id', uid)
          .eq('flag_level', 'review');

        for (const p of reviewProfiles || []) {
          const fingerprint = `customer-review:${p.customer_key}`;
          const asinLabel = (p.distinct_asins || []).length === 1 ? (p.distinct_asins as string[])[0] : `${(p.distinct_asins || []).length} ASINs`;
          const title = `Repeat refund/replacement — ${asinLabel}`;
          const impact = `Customer ${p.buyer_email || p.buyer_name || p.customer_key} has ${p.orders_count} orders, ${p.refund_orders_count} refunds ($${Number(p.refund_amount_usd || 0).toFixed(2)}), ${p.replacement_orders_count} replacements.`;
          const recommended_fix = 'Review the customer history and, if warranted, open an A-to-z / abuse case in Seller Central. Do not submit automated cases.';
          const affected_entities = {
            customer_key: p.customer_key,
            buyer_email: p.buyer_email,
            buyer_name: p.buyer_name,
            order_ids: p.order_ids || [],
            asins: p.distinct_asins || [],
            refund_amount_usd: p.refund_amount_usd,
          };

          const { error: healthErr } = await supabase.from('business_health_issues').upsert(
            {
              user_id: uid,
              fingerprint,
              module: 'customer_intelligence',
              severity: 'warning',
              confidence: 'high',
              title,
              impact,
              recommended_fix,
              occurrence_count: p.orders_count || 1,
              first_seen: p.last_seen_at || new Date().toISOString(),
              last_seen: p.last_seen_at || new Date().toISOString(),
              affected_entities,
              routes: ['/tools/live-sales', '/tools/sales'],
              functions: ['backfill-customer-profiles'],
              sources: ['customer_profiles'],
              status: 'open',
              retryable: false,
              display_category: 'Customers',
            },
            { onConflict: 'user_id,fingerprint' }
          );
          if (!healthErr) stats.healthIssues++;
        }
      }

      perUserStats.push(stats);
    }

    return new Response(JSON.stringify({ ok: true, users: perUserStats }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
