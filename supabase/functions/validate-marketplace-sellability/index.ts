// validate-marketplace-sellability
// Re-validates non-US repricer_assignments and writes:
//   marketplace_sellable boolean
//   marketplace_sellability_reason text
//   marketplace_checked_at  timestamptz
//
// Modes:
//   - Per-user/marketplace ad-hoc call: { marketplace: "CA", asins: [...] } with caller JWT.
//     Validates only the given ASINs for that caller.
//   - Cron sweep: { mode: "sweep", limit?: number } with service-role.
//     Walks the oldest-checked non-US assignments across all users (capped batch).
//
// The "sellable" decision mirrors src/lib/marketplace/isSellable.ts:
//   non-US sellable iff intl_listing_status contains BUYABLE AND eligibility cache
//   has no APPROVAL_REQUIRED / RESTRICTED / NOT_ELIGIBLE / etc.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESTRICTION_CODES = new Set([
  "RESTRICTED",
  "NOT_ELIGIBLE",
  "APPROVAL_REQUIRED",
  "ASIN_NOT_ELIGIBLE",
  "BRAND_NOT_ELIGIBLE",
  "RESTRICTION",
]);

const MARKETPLACE_IDS: Record<string, string> = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
  UK: "A1F83G8C2ARO7P",
  DE: "A1PA6795UKMFR9",
  FR: "A13V1IB3VIYZZH",
  IT: "APJ6JRA9NG5V4",
  ES: "A1RKKUPIHCS9HS",
};

function parseIntlStatus(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).toUpperCase());
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).toUpperCase());
    } catch { /* ignore */ }
  }
  return s.split(/[,\s]+/).map((x) => x.replace(/["\[\]]/g, "").toUpperCase()).filter(Boolean);
}

type Decision = { sellable: boolean; reason: string };

function decide(intlStatus: unknown, eligibility: { eligible?: boolean | null; blocking_issues?: any[] | null } | null): Decision {
  const statuses = parseIntlStatus(intlStatus);
  if (statuses.length === 0 || statuses.includes("UNKNOWN") || statuses.includes("NOT_FOUND")) {
    return { sellable: false, reason: "status_unknown" };
  }
  if (!statuses.includes("BUYABLE")) {
    return { sellable: false, reason: "not_buyable" };
  }
  if (eligibility && eligibility.eligible === false) {
    const issues = Array.isArray(eligibility.blocking_issues) ? eligibility.blocking_issues : [];
    const hasApproval = issues.some((it: any) => String(it?.code || "").toUpperCase() === "APPROVAL_REQUIRED");
    if (hasApproval) return { sellable: false, reason: "approval_required" };
    const hasRestriction = issues.some((it: any) => RESTRICTION_CODES.has(String(it?.code || "").toUpperCase()));
    if (hasRestriction) return { sellable: false, reason: "restricted" };
  }
  return { sellable: true, reason: "buyable" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === "sweep" ? "sweep" : "scoped";

    // SCOPED: caller-driven, requires JWT
    if (mode === "scoped") {
      const authHeader = req.headers.get("authorization") || "";
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await userClient.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const marketplace = String(body?.marketplace || "").toUpperCase();
      const asins: string[] = Array.isArray(body?.asins) ? body.asins.filter((x: any) => typeof x === "string") : [];
      if (!marketplace || marketplace === "US" || asins.length === 0) {
        return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const result = await processBatch(admin, userId, marketplace, asins.slice(0, 200));
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // SWEEP: only validate non-US rows for ASINs that are ACTIVE in US inventory.
    // This avoids wasting checks on stale/inactive/deleted listings and follows
    // the business reality: non-US (CA/MX/BR) is just a remote-fulfillment extension
    // of the active US catalog.
    const limit = Math.min(Math.max(Number(body?.limit) || 200, 1), 1000);
    const staleAfterMs = 1000 * 60 * 60 * 6; // re-check each ASIN at most every 6h
    const staleCutoff = new Date(Date.now() - staleAfterMs).toISOString();

    // 1) Pull active US ASINs (any stock OR any assignment) — paginated so we
    //    can scan above the 1000-row Supabase default.
    const activeAsinByUser = new Map<string, Set<string>>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data: invRows, error: invErr } = await admin
        .from("inventory")
        .select("user_id, asin, available, reserved, inbound, listing_status")
        .or("available.gt.0,reserved.gt.0,inbound.gt.0")
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (invErr) throw invErr;
      const rows = invRows || [];
      for (const r of rows as any[]) {
        const ls = String(r.listing_status || "").toUpperCase();
        if (ls === "NOT_IN_CATALOG" || ls === "DELETED" || ls.includes("INACTIVE") || ls === "INCOMPLETE" || ls === "SUPPRESSED") continue;
        const asin = (r.asin || "").trim();
        if (!asin || !r.user_id) continue;
        if (!activeAsinByUser.has(r.user_id)) activeAsinByUser.set(r.user_id, new Set());
        activeAsinByUser.get(r.user_id)!.add(asin);
      }
      if (rows.length < pageSize) break;
    }

    // 2) For each user, find their stale non-US assignments whose ASIN is in the active set.
    const groups = new Map<string, { userId: string; marketplace: string; asins: string[] }>();
    let totalCandidates = 0;
    for (const [userId, asinSet] of activeAsinByUser.entries()) {
      if (totalCandidates >= limit) break;
      const asinList = [...asinSet];
      // Chunk IN() to avoid URL limits
      for (let i = 0; i < asinList.length && totalCandidates < limit; i += 200) {
        const chunk = asinList.slice(i, i + 200);
        const { data: asgRows } = await admin
          .from("repricer_assignments")
          .select("marketplace, asin, marketplace_checked_at")
          .eq("user_id", userId)
          .neq("marketplace", "US")
          .in("asin", chunk)
          .or(`marketplace_checked_at.is.null,marketplace_checked_at.lt.${staleCutoff}`)
          .limit(limit - totalCandidates);
        for (const r of (asgRows || []) as any[]) {
          const key = `${userId}::${r.marketplace}`;
          if (!groups.has(key)) groups.set(key, { userId, marketplace: r.marketplace, asins: [] });
          groups.get(key)!.asins.push(r.asin);
          totalCandidates++;
          if (totalCandidates >= limit) break;
        }
      }
    }

    let totalUpdated = 0, totalHidden = 0;
    for (const g of groups.values()) {
      const result = await processBatch(admin, g.userId, g.marketplace, g.asins);
      totalUpdated += result.updated;
      totalHidden += result.hidden;
    }

    return new Response(JSON.stringify({
      ok: true,
      mode: "active_us_driven",
      users_with_active_us: activeAsinByUser.size,
      groups: groups.size,
      scanned: totalCandidates,
      updated: totalUpdated,
      hidden: totalHidden,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("[validate-marketplace-sellability]", e?.message, e?.stack);
    return new Response(JSON.stringify({ error: e?.message || "unknown" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function processBatch(admin: any, userId: string, marketplace: string, asins: string[]) {
  const mktId = MARKETPLACE_IDS[marketplace];
  const uniqueAsins = [...new Set(asins.filter(Boolean))];

  // Pull intl_listing_status from repricer_assignments
  const intlMap = new Map<string, unknown>();
  for (let i = 0; i < uniqueAsins.length; i += 200) {
    const chunk = uniqueAsins.slice(i, i + 200);
    const { data } = await admin
      .from("repricer_assignments")
      .select("asin, intl_listing_status")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .in("asin", chunk);
    for (const r of (data || []) as any[]) intlMap.set(r.asin, r.intl_listing_status);
  }

  // Pull eligibility from fba_eligibility_cache (if rows exist)
  const eligMap = new Map<string, { eligible: boolean | null; blocking_issues: any[] | null }>();
  if (mktId) {
    for (let i = 0; i < uniqueAsins.length; i += 200) {
      const chunk = uniqueAsins.slice(i, i + 200);
      const { data } = await admin
        .from("fba_eligibility_cache")
        .select("asin, eligible, blocking_issues")
        .eq("user_id", userId)
        .eq("marketplace_id", mktId)
        .in("asin", chunk);
      for (const r of (data || []) as any[]) {
        eligMap.set(r.asin, { eligible: r.eligible, blocking_issues: r.blocking_issues });
      }
    }
  }

  // Decide + update
  const now = new Date().toISOString();
  let updated = 0, hidden = 0;
  // Group updates by (sellable, reason) to do bulk updates
  type Bucket = { sellable: boolean; reason: string; asins: string[] };
  const buckets = new Map<string, Bucket>();
  for (const asin of uniqueAsins) {
    const d = decide(intlMap.get(asin), eligMap.get(asin) || null);
    const key = `${d.sellable}|${d.reason}`;
    if (!buckets.has(key)) buckets.set(key, { sellable: d.sellable, reason: d.reason, asins: [] });
    buckets.get(key)!.asins.push(asin);
    if (!d.sellable) hidden++;
  }
  for (const b of buckets.values()) {
    for (let i = 0; i < b.asins.length; i += 200) {
      const chunk = b.asins.slice(i, i + 200);
      const { error } = await admin
        .from("repricer_assignments")
        .update({
          marketplace_sellable: b.sellable,
          marketplace_sellability_reason: b.reason,
          marketplace_checked_at: now,
        })
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .in("asin", chunk);
      if (!error) updated += chunk.length;
    }
  }
  return { updated, hidden };
}
