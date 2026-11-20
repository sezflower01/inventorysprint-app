// Cron fan-out: enumerate active users with inventory rows and invoke
// inventory-review-scan (read-only) for each, so the "needs review" queue
// gets populated automatically instead of relying on someone remembering to
// click "Scan Now". Mirrors refresh-inventory-valuation-summary-all's
// enumeration pattern.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const internalSecret = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";
  const admin = createClient(supabaseUrl, serviceKey);

  // "Active" = at least one inventory row updated in the last 7 days.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const userIds = new Set<string>();

  let from = 0; const PAGE = 1000;
  for (let i = 0; i < 50; i += 1) {
    const { data, error } = await admin
      .from("inventory")
      .select("user_id, updated_at")
      .gte("updated_at", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("[inventory-review-scan-all] active-user enumeration error", error); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.user_id) userIds.add(r.user_id as string);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const invokeUrl = `${supabaseUrl}/functions/v1/inventory-review-scan`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
    "x-internal-secret": internalSecret,
  };

  let ok = 0, failed = 0, totalFlagged = 0, totalNew = 0;
  for (const uid of userIds) {
    try {
      const res = await fetch(invokeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: uid }),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        ok += 1;
        totalFlagged += j?.flagged ?? 0;
        totalNew += j?.new_entries ?? 0;
      } else {
        failed += 1;
        console.warn(`[inventory-review-scan-all] scan failed for ${uid}: HTTP ${res.status}`);
      }
    } catch (e) {
      failed += 1;
      console.error(`[inventory-review-scan-all] invoke failed for ${uid}`, e);
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  return new Response(
    JSON.stringify({ ok: true, users: userIds.size, scanned_ok: ok, failed, total_flagged: totalFlagged, total_new_entries: totalNew }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
