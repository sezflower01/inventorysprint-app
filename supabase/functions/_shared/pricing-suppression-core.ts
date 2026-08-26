// Shared core for pricing-suppression detection + two-strike clearing.
// Used by both detect-pricing-suppressions (bulk, per-user, called by the
// "Check now" button) and check-pricing-suppression-item (single-item,
// called by pricing-suppression-worker to drain pricing_suppression_check_queue
// in small batches so a large catalog never hits a single-invocation resource
// limit the way the original all-in-one bulk loop did).

import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts';
import { waitForApiToken } from './rate-limiter.ts';

export const MARKETPLACES: Array<{ code: string; id: string }> = [
  { code: 'US', id: 'ATVPDKIKX0DER' },
  { code: 'CA', id: 'A2EUQ1WTGCTBG2' },
  { code: 'MX', id: 'A1AM78C64UM0Y8' },
  { code: 'BR', id: 'A2Q3Y263D00KWC' },
];

// Non-pricing buckets observed from the live probe. If every category on an
// ERROR+LISTING_SUPPRESSED issue is in this set, it's a known non-pricing
// suppression (brand gate, missing attribute) and we do NOT flag it for
// admin review.
const KNOWN_NON_PRICING_CATEGORIES = new Set([
  'QUALIFICATION_REQUIRED',
  'MISSING_ATTRIBUTE',
  'INVALID_ATTRIBUTE', // co-occurs with INVALID_PRICE on real pricing issues; safe here because
                       // pricing is detected BEFORE the unknown check (see classifyIssues).
]);

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}
function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}
function sig(stringToSign: string, signingKey: Uint8Array): string {
  const hmac = createHmac('sha256', signingKey as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

export async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Missing LWA credentials');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error(`LWA ${response.status}: ${t.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.access_token;
}

export async function callGetListingsItem(
  supabase: any,
  accessToken: string,
  sellerId: string,
  sku: string,
  marketplaceId: string,
): Promise<{ http_status: number; body: any }> {
  const awsKey = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecret = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  if (!awsKey || !awsSecret) throw new Error('Missing AWS creds');

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: 'summaries,issues',
  }).toString();

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = `GET\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const reqHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${reqHash}`;
  const signingKey = getSigningKey(awsSecret, dateStamp, region, service);
  const signature = sig(stringToSign, signingKey);

  await waitForApiToken(supabase, 'listings_api');
  const resp = await fetch(`https://${host}${path}?${query}`, {
    method: 'GET',
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${awsKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  const text = await resp.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { http_status: resp.status, body };
}

interface Classified {
  pricingIssue: any | null;      // the INVALID_PRICE + ERROR issue if any
  unknownFlagged: boolean;
  unknownCategories: string[];
}

export function classifyIssues(issues: any[]): Classified {
  let pricingIssue: any = null;
  const unknownCatsSet = new Set<string>();

  for (const iss of issues) {
    const cats: string[] = Array.isArray(iss?.categories) ? iss.categories : [];
    const actions: string[] = (iss?.enforcements?.actions || []).map((a: any) => a?.action).filter(Boolean);
    const severity = String(iss?.severity || '').toUpperCase();

    const isPricing = cats.includes('INVALID_PRICE') && severity === 'ERROR';
    if (isPricing && !pricingIssue) {
      pricingIssue = iss;
      continue;
    }
    if (isPricing) continue;

    // Unknown-bucket detection: hard suppression + ERROR that we don't recognize.
    const isSuppressed = actions.includes('LISTING_SUPPRESSED');
    if (isSuppressed && severity === 'ERROR' && cats.length > 0) {
      const allKnown = cats.every((c) => KNOWN_NON_PRICING_CATEGORIES.has(c));
      if (!allKnown) {
        for (const c of cats) if (!KNOWN_NON_PRICING_CATEGORIES.has(c)) unknownCatsSet.add(c);
      }
    }
  }

  return {
    pricingIssue,
    unknownFlagged: unknownCatsSet.size > 0,
    unknownCategories: [...unknownCatsSet],
  };
}

export interface SuppressionAssignmentRow {
  id: string;
  sku: string;
  asin: string | null;
  is_pricing_suppression: boolean | null;
  pricing_suppression_pending_clear_at: string | null;
  pricing_suppression_detected_at: string | null;
  pricing_suppression_raw_code: string | null;
  pricing_suppression_raw_message: string | null;
  pricing_suppression_categories: string[] | null;
  pricing_suppression_enforcement_actions: string[] | null;
  pricing_suppression_severity: string | null;
  is_listing_inactive_not_buyable: boolean | null;
  listing_inactive_reason_code: string | null;
  listing_inactive_reason_message: string | null;
  listing_inactive_detected_at: string | null;
}

// A listing summary can report DISCOVERABLE (shows in search/browse) without
// BUYABLE or ACTIVE (can actually be purchased) -- e.g. Amazon's "Fix Price
// Alert" deactivation, which sets remote-fulfillment inventory to 0 in that
// marketplace without generating an issues[] entry classifyIssues() would
// catch. Distinct from is_pricing_suppression: that field is specifically
// for the issues[]-based INVALID_PRICE+ERROR+LISTING_SUPPRESSED signal, and
// the two can occur independently (a listing can have a real pricing issue
// AND still show BUYABLE, or be not-buyable with no issue reported at all).
function summaryLooksBuyable(summary: any): boolean {
  const raw = summary?.status;
  const statuses: string[] = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map((s: any) => String(s || '').toUpperCase());
  return statuses.some((s) => s === 'BUYABLE' || s === 'ACTIVE');
}

// Checks ONE assignment against Amazon and applies detect / two-strike-clear
// writes + the audit row. Shared by the bulk per-user loop and the per-item
// queue worker so both paths behave identically.
export async function checkAndUpdateSuppressionForItem(params: {
  supabase: any;
  userId: string;
  runId: string;
  accessToken: string;
  sellerId: string;
  marketplaceCode: string;
  marketplaceId: string;
  assignment: SuppressionAssignmentRow;
}): Promise<{ action_taken: string; error?: string; unknownFlagged: boolean }> {
  const { supabase, userId, runId, accessToken, sellerId, marketplaceCode, marketplaceId, assignment: a } = params;

  let http_status = 0;
  let summaries_non_empty = false;
  let trust_gate = false;
  let issues_seen: any[] = [];
  let action_taken = 'skipped_untrusted';
  let notes: string | null = null;
  let unknownFlaggedResult = false;

  try {
    const { http_status: hs, body } = await callGetListingsItem(supabase, accessToken, sellerId, a.sku, marketplaceId);
    http_status = hs;
    const summaries = Array.isArray(body?.summaries) ? body.summaries : [];
    summaries_non_empty = summaries.length > 0;
    issues_seen = Array.isArray(body?.issues) ? body.issues : [];
    trust_gate = hs === 200 && summaries_non_empty;

    if (!trust_gate) {
      notes = `trust_gate_failed http=${hs} summaries=${summaries.length}`;
    } else {
      const { pricingIssue, unknownFlagged, unknownCategories } = classifyIssues(issues_seen);
      unknownFlaggedResult = unknownFlagged;

      const unknownPatch: any = {
        listing_issue_unknown_flagged: unknownFlagged,
        listing_issue_unknown_categories: unknownFlagged ? unknownCategories : null,
      };

      // Independent of the issues[]-based pricing check above: a listing can
      // report DISCOVERABLE without BUYABLE/ACTIVE (Amazon's "Fix Price
      // Alert" deactivation is the known case) with no corresponding issues[]
      // entry at all, so classifyIssues() alone never catches it. Detected
      // and cleared the same single-strike way as is_pricing_suppression.
      const matchedSummary = summaries.find((s: any) => s?.marketplaceId === marketplaceId);
      const wasNotBuyable = a.is_listing_inactive_not_buyable === true;
      const isNotBuyable = !!matchedSummary && !summaryLooksBuyable(matchedSummary);
      const rawStatuses: string[] = (Array.isArray(matchedSummary?.status)
        ? matchedSummary.status
        : matchedSummary?.status ? [matchedSummary.status] : []
      ).map((s: any) => String(s || '').toUpperCase());
      // WHY it is not buyable, not just THAT it is.
      //
      // issues_seen is already fetched (includedData: 'summaries,issues' above)
      // but was consumed only by classifyIssues(), which looks for
      // INVALID_PRICE-style entries. A counterfeit or IP block produces an
      // issues[] entry with severity ERROR and no pricing category, so
      // classifyIssues ignored it and the reason was discarded -- leaving the
      // app able to say "paused" but never "blocked, and here is why".
      //
      // This is the text Seller Central shows as "Review blocked reason".
      // Prefer a hard ERROR; fall back to whatever came back so a
      // WARNING-only block is still explained rather than silently dropped.
      const blockingIssue =
        issues_seen.find((i: any) => String(i?.severity || '').toUpperCase() === 'ERROR') ||
        issues_seen[0] ||
        null;
      const notBuyablePatch: any = isNotBuyable
        ? {
            is_listing_inactive_not_buyable: true,
            listing_inactive_statuses: rawStatuses,
            // Null rather than '' when Amazon sends no issue: Fix Price Alert
            // deactivations genuinely carry no issues[] entry, and an empty
            // string would read as "we looked and found nothing" when the truth
            // is "Amazon did not say".
            listing_inactive_reason_code: blockingIssue ? String(blockingIssue.code || '') || null : null,
            listing_inactive_reason_message: blockingIssue
              ? (String(blockingIssue.message || '').slice(0, 500) || null)
              : null,
            listing_inactive_detected_at: wasNotBuyable && a.listing_inactive_detected_at
              ? a.listing_inactive_detected_at
              : new Date().toISOString(),
            listing_inactive_cleared_at: null,
            listing_inactive_last_checked_at: new Date().toISOString(),
          }
        : wasNotBuyable
          ? {
              is_listing_inactive_not_buyable: false,
              // Clear the reason with the flag. A stale "counterfeit review"
              // left on a listing Amazon has since restored is worse than no
              // reason at all.
              listing_inactive_reason_code: null,
              listing_inactive_reason_message: null,
              listing_inactive_cleared_at: new Date().toISOString(),
              listing_inactive_last_checked_at: new Date().toISOString(),
            }
          : { listing_inactive_last_checked_at: new Date().toISOString() };

      if (pricingIssue) {
        const cats: string[] = pricingIssue.categories || [];
        const actions: string[] = (pricingIssue.enforcements?.actions || []).map((x: any) => x?.action).filter(Boolean);
        const alreadySuppressed = a.is_pricing_suppression === true;
        const detectedAt = alreadySuppressed && a.pricing_suppression_detected_at
          ? a.pricing_suppression_detected_at
          : new Date().toISOString();
        await supabase.from('repricer_assignments').update({
          ...unknownPatch,
          ...notBuyablePatch,
          is_pricing_suppression: true,
          pricing_suppression_raw_code: String(pricingIssue.code || ''),
          pricing_suppression_raw_message: String(pricingIssue.message || ''),
          pricing_suppression_categories: cats,
          pricing_suppression_enforcement_actions: actions,
          pricing_suppression_severity: String(pricingIssue.severity || ''),
          pricing_suppression_detected_at: detectedAt,
          pricing_suppression_cleared_at: null,
          pricing_suppression_pending_clear_at: null,
          pricing_suppression_last_checked_at: new Date().toISOString(),
        }).eq('id', a.id);
        action_taken = alreadySuppressed ? 'kept_suppressed' : 'detected';
      } else if (a.is_pricing_suppression) {
        // Single-strike clear: one clean read (http 200, real summaries, no
        // INVALID_PRICE+ERROR issue) is enough to clear immediately. The
        // previous two-strike design staged a "pending clear" and required a
        // SECOND separate clean read (up to a full day later via the nightly
        // cron) before actually clearing -- meant to guard against a flaky
        // API response falsely clearing a still-broken listing. Removed per
        // explicit user decision: if the issue genuinely persists, the next
        // detection pass re-flags it anyway (is_pricing_suppression=true,
        // fresh detected_at), so the two-strike wait only added delay, not
        // real protection.
        const clearedAt = new Date().toISOString();
        await supabase.from('repricer_pricing_suppression_history').insert({
          user_id: userId,
          sku: a.sku,
          asin: a.asin,
          marketplace: marketplaceCode,
          raw_code: a.pricing_suppression_raw_code,
          raw_message: a.pricing_suppression_raw_message,
          categories: a.pricing_suppression_categories,
          enforcement_actions: a.pricing_suppression_enforcement_actions,
          severity: a.pricing_suppression_severity,
          was_pricing_suppression: true,
          detected_at: a.pricing_suppression_detected_at || clearedAt,
          cleared_at: clearedAt,
        });
        await supabase.from('repricer_assignments').update({
          ...unknownPatch,
          ...notBuyablePatch,
          is_pricing_suppression: false,
          pricing_suppression_raw_code: null,
          pricing_suppression_raw_message: null,
          pricing_suppression_categories: null,
          pricing_suppression_enforcement_actions: null,
          pricing_suppression_severity: null,
          pricing_suppression_detected_at: null,
          pricing_suppression_cleared_at: clearedAt,
          pricing_suppression_pending_clear_at: null,
          pricing_suppression_last_checked_at: clearedAt,
        }).eq('id', a.id);
        action_taken = 'cleared';
      } else {
        await supabase.from('repricer_assignments').update({
          ...unknownPatch,
          ...notBuyablePatch,
          pricing_suppression_last_checked_at: new Date().toISOString(),
        }).eq('id', a.id);
        action_taken = isNotBuyable && !wasNotBuyable ? 'detected_not_buyable' : (wasNotBuyable && !isNotBuyable ? 'cleared_not_buyable' : 'clean');
      }
    }
  } catch (e: any) {
    notes = `error: ${String(e?.message || e).slice(0, 250)}`;
    action_taken = 'error';
  }

  await supabase.from('repricer_pricing_suppression_checks').insert({
    user_id: userId,
    run_id: runId,
    sku: a.sku,
    asin: a.asin,
    marketplace: marketplaceCode,
    http_status,
    summaries_non_empty,
    trust_gate_passed: trust_gate,
    issues_seen,
    action_taken,
    notes,
  });

  return { action_taken, error: notes ?? undefined, unknownFlagged: unknownFlaggedResult };
}
