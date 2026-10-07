import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
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

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authHeader,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('LWA token error:', error);
    throw new Error('Failed to get LWA access token');
  }

  const data = await response.json();
  return data.access_token;
}

// Fetch single order status from Amazon Orders API
async function getOrderStatus(accessToken: string, orderId: string): Promise<{ status: string; lastUpdateDate?: string } | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}`;
  const headers = await signRequest('GET', url, '', accessToken);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 429) {
    console.warn(`[REFRESH_STATUS] Rate limited for ${orderId}, retrying once...`);
    await new Promise(r => setTimeout(r, 2000));
    const retryHeaders = await signRequest('GET', url, '', accessToken);
    const retryResponse = await fetch(url, {
      method: 'GET',
      headers: { ...retryHeaders, 'Content-Type': 'application/json' },
    });
    
    if (retryResponse.ok) {
      const data = await retryResponse.json();
      const order = data.payload;
      return { 
        status: order?.OrderStatus,
        lastUpdateDate: order?.LastUpdateDate
      };
    }
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(`[REFRESH_STATUS] Failed to get order ${orderId}: ${response.status} ${text.slice(0, 200)}`);
    return null;
  }

  const data = await response.json();
  const order = data.payload;
  return { 
    status: order?.OrderStatus,
    lastUpdateDate: order?.LastUpdateDate
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify JWT
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { order_id, order_ids, marketplace_id } = body;
    /**
     * dryRun: ask Amazon, change nothing.
     *
     * This function is the only thing that can answer "what does Amazon say
     * about THIS order id" -- the hourly sync-order-status-updates queries by
     * LastUpdatedAfter, so an order Amazon has not touched in months is
     * invisible to it no matter how often it runs. But the normal path writes,
     * and writing includes zeroing quantity and every fee on a cancelled
     * order, which is not something to do to 449 rows before anyone has seen
     * the distribution. So: look first.
     */
    const dryRun = body?.dryRun === true;
    
    // Support single order or batch of orders
    const orderIdsToProcess: string[] = order_ids || (order_id ? [order_id] : []);
    
    if (orderIdsToProcess.length === 0) {
      return new Response(JSON.stringify({ error: 'order_id or order_ids required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[REFRESH_STATUS] Starting status refresh for ${orderIdsToProcess.length} order(s) for user ${user.id}`);

    // Get user's SP-API credentials from seller_authorizations
    const targetMarketplace = marketplace_id || 'ATVPDKIKX0DER';
    
    const { data: authRows, error: authFetchError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, seller_id, marketplace_id')
      .eq('user_id', user.id);

    const authRow = authRows?.find(a => a.marketplace_id === targetMarketplace) || authRows?.[0];
    if (authFetchError || !authRow?.refresh_token) {
      console.error('[REFRESH_STATUS] No seller authorization found');
      return new Response(JSON.stringify({ error: 'Amazon account not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(authRow.refresh_token);
    
    const results: { order_id: string; old_status: string | null; new_status: string; is_cancelled: boolean; success: boolean; error?: string }[] = [];
    
    for (const oid of orderIdsToProcess) {
      // Strip -REFUND suffix if present for API call
      const baseOrderId = oid.replace(/-REFUND(-\d+)?$/, '');
      
      try {
        const orderResult = await getOrderStatus(accessToken, baseOrderId);
        
        if (!orderResult || !orderResult.status) {
          results.push({ order_id: oid, old_status: null, new_status: '', is_cancelled: false, success: false, error: 'Failed to fetch from Amazon' });
          continue;
        }

        const amazonStatus = orderResult.status;
        const isCancelled = amazonStatus === 'Canceled' || amazonStatus === 'Cancelled';
        const now = new Date().toISOString();

        // Get current order data
        const { data: currentOrder } = await supabase
          .from('sales_orders')
          .select('order_status, is_cancelled')
          .eq('user_id', user.id)
          .eq('order_id', oid)
          .maybeSingle();

        const updates: Record<string, any> = {
          order_status: amazonStatus,
          is_cancelled: isCancelled,
          last_status_sync_at: now,
          status_source: 'amazon',
          updated_at: now,
        };

        // If cancelled, zero out quantities and set cancelled_at
        if (isCancelled) {
          updates.cancelled_at = now;
          updates.quantity = 0;
          updates.sold_price = 0;
          updates.total_sale_amount = 0;
          updates.referral_fee = 0;
          updates.fba_fee = 0;
          updates.closing_fee = 0;
          updates.total_fees = 0;
          updates.refund_amount = 0;
        }

        if (dryRun) {
          results.push({
            order_id: oid,
            old_status: currentOrder?.order_status ?? null,
            new_status: amazonStatus,
            is_cancelled: isCancelled,
            success: true,
            error: `DRY RUN - nothing written (we had is_cancelled=${currentOrder?.is_cancelled})`,
          });
          if (orderIdsToProcess.indexOf(oid) < orderIdsToProcess.length - 1) {
            await new Promise(r => setTimeout(r, 200));
          }
          continue;
        }

        // Update all rows with this order_id (including -REFUND variants)
        const { error: updateError } = await supabase
          .from('sales_orders')
          .update(updates)
          .eq('user_id', user.id)
          .like('order_id', `${baseOrderId}%`);

        if (updateError) {
          console.error(`[REFRESH_STATUS] Update failed for ${oid}:`, updateError.message);
          results.push({ order_id: oid, old_status: currentOrder?.order_status, new_status: amazonStatus, is_cancelled: isCancelled, success: false, error: updateError.message });
        } else {
          console.log(`[REFRESH_STATUS] ✓ ${oid}: ${currentOrder?.order_status || 'unknown'} -> ${amazonStatus}${isCancelled ? ' (cancelled, zeroed)' : ''}`);
          results.push({ order_id: oid, old_status: currentOrder?.order_status, new_status: amazonStatus, is_cancelled: isCancelled, success: true });
        }

        // Rate limiting: 200ms between API calls
        if (orderIdsToProcess.indexOf(oid) < orderIdsToProcess.length - 1) {
          await new Promise(r => setTimeout(r, 200));
        }

      } catch (err: any) {
        console.error(`[REFRESH_STATUS] Error for ${oid}:`, (err as Error).message);
        results.push({ order_id: oid, old_status: null, new_status: '', is_cancelled: false, success: false, error: (err as Error).message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const cancelledCount = results.filter(r => r.is_cancelled).length;

    console.log(`[REFRESH_STATUS] Complete: ${successCount}/${orderIdsToProcess.length} updated, ${cancelledCount} cancelled`);

    return new Response(JSON.stringify({
      success: true,
      updated: successCount,
      cancelled: cancelledCount,
      total: orderIdsToProcess.length,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[REFRESH_STATUS] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
